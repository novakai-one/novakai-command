import type { Outcome } from "../../contract/outcome.js";
import type {
  IngestResult,
  DeliveryRunResult,
  MessagingHealth,
  MessagingRuntimeApi,
} from "../../contract/runtime.js";
import type {
  ProviderNormalizer,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type {
  TranscriptLineQuery,
  TranscriptStore,
} from "../../contract/ports/transcript-store.js";
import type { ProviderSession } from "../../contract/records/provider-session.js";
import type { TranscriptLine } from "../../contract/records/transcript-line.js";
import type {
  ProviderName,
  ProviderResumeId,
  ProviderSessionId,
  TranscriptSourceId,
} from "../../contract/types.js";
import { MessagingError } from "../../contract/types.js";
import { createDurableTranscriptEventBus, type DurableTranscriptEventBus } from "../event-bus.js";
import { ingestNow as runIngest } from "./ingest.js";
import type {
  AdoptionAssignment,
  AgentDirectory,
} from "../../contract/ports/agent-directory.js";
import type { ConversationDirectory } from "../../contract/ports/conversation-directory.js";
import type { ProviderSend } from "../../contract/ports/provider-send.js";
import type { ConversationSendAcceptance, ConversationSendInput } from "../../contract/commands.js";
import type { SendJournal } from "../../contract/records/send-journal.js";
import { sendConversationMessage } from "../send/send.js";
import { AmbiguousProviderSessionEvidenceError } from "./reconcile.js";
import { AddressedDeliveryReconciler } from '../delivery/queue-addressed.js';
import { routePendingDeliveries } from '../delivery/router.js';
import type {
  AgentCommunicationPage,
  AgentCommunicationsQuery,
} from '../../contract/communications.js';
import { listAgentCommunications as communicationQuery } from '../communications/queries.js';

/** Dependencies and cadence for the provider-transcript ingestion runtime. */
export interface MessagingRuntimeOptions {
  readonly store: TranscriptStore;
  readonly source: ProviderTranscriptSource;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly now?: () => string;
  readonly intervalMs?: number;
  readonly eventBus?: DurableTranscriptEventBus;
  readonly agentDirectory?: AgentDirectory;
  readonly providerSend?: ProviderSend;
  readonly conversations?: ConversationDirectory;
  readonly adoption?: {
    readonly assignment: AdoptionAssignment;
    readonly conversations: ConversationDirectory;
    readonly limitPerTick: number;
  };
}

const unavailable = <T>(cause: unknown): Outcome<T> => ({
  kind: "error",
  error: new MessagingError("DependencyUnavailable", {
    message: cause instanceof Error ? cause.message : "Messaging ingestion unavailable",
    retryable: true,
    fields: { dependency: "provider-transcript" },
  }),
});

const ingestFailure = <T>(cause: unknown): Outcome<T> => {
  if (cause instanceof AmbiguousProviderSessionEvidenceError) {
    return {
      kind: 'error',
      error: new MessagingError('IdempotencyConflict', {
        message: cause.message,
        fields: {
          sourceId: cause.sourceId,
          resumeId: cause.resumeId,
          sessionIds: cause.sessionIds,
        },
      }),
    };
  }
  return unavailable(cause);
};

function lineQuery(input: unknown): TranscriptLineQuery {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Transcript line query must be an object");
  }
  const value = input as Record<string, unknown>;
  return {
    ...(typeof value.sessionId === "string"
      ? { sessionId: value.sessionId as ProviderSessionId } : {}),
    ...(value.provider === "claude" || value.provider === "codex" || value.provider === "kimi"
      ? { provider: value.provider } : {}),
    ...(typeof value.sourceId === "string"
      ? { sourceId: value.sourceId as TranscriptSourceId } : {}),
    ...(typeof value.resumeId === "string"
      ? { resumeId: value.resumeId as ProviderResumeId } : {}),
  };
}

class IngestionRuntime implements MessagingRuntimeApi {
  readonly eventBus: DurableTranscriptEventBus;
  private readonly clock: () => string;
  private readonly intervalMs: number;
  private state: MessagingHealth["state"] = "stopped";
  private timer: ReturnType<typeof setInterval> | undefined;
  private runs = 0;
  private lastResult: IngestResult | undefined;
  private lastError: string | undefined;
  private inFlight: Promise<Outcome<IngestResult>> | undefined;
  private deliveryInFlight: Promise<Outcome<DeliveryRunResult>> | undefined;
  private lastDeliveryRunAt: string | undefined;
  private readonly addressedDeliveries = new AddressedDeliveryReconciler();

  constructor(private readonly options: MessagingRuntimeOptions) {
    this.clock = options.now ?? (() => new Date().toISOString());
    this.intervalMs = options.intervalMs ?? 1_000;
    this.eventBus = options.eventBus ?? createDurableTranscriptEventBus(options.store);
  }

  async start(): Promise<Outcome<void>> {
    if (this.state !== "stopped") return { kind: "ok", value: undefined };
    this.state = "running";
    const first = await this.ingestNow();
    if (first.kind === "error") return first;
    this.timer = setInterval(() => { void this.ingestNow(); }, this.intervalMs);
    this.timer.unref();
    return { kind: "ok", value: undefined };
  }

  async stop(): Promise<Outcome<void>> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.inFlight !== undefined) await this.inFlight;
    this.state = "stopped";
    return { kind: "ok", value: undefined };
  }

  async health(): Promise<MessagingHealth> {
    return {
      state: this.state,
      ingesting: this.inFlight !== undefined,
      runs: this.runs,
      ...(this.lastResult === undefined ? {} : { lastResult: this.lastResult }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastDeliveryRunAt === undefined ? {} : { lastDeliveryRunAt: this.lastDeliveryRunAt }),
      pendingDeliveryCount: (await this.options.store.listPendingDeliveries())
        .filter((delivery) => delivery.state === 'queued' || delivery.state === 'claimed').length,
    };
  }

  ingestNow(): Promise<Outcome<IngestResult>> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = this.runOnce();
    return this.inFlight;
  }

  private async runOnce(): Promise<Outcome<IngestResult>> {
    try {
      const value = await runIngest({
        store: this.options.store,
        source: this.options.source,
        normalizers: this.options.normalizers,
        now: this.clock,
        ...(this.options.agentDirectory === undefined
          ? {} : { agentDirectory: this.options.agentDirectory }),
        ...(this.options.adoption === undefined ? {} : { adoption: this.options.adoption }),
      });
      await this.addressedDeliveries.reconcile(this.options.store);
      if (this.deliveryComposed()) {
        const routed = await this.routePending();
        if (routed.kind === 'error') throw routed.error;
      }
      await this.eventBus.pump();
      this.runs += 1;
      this.lastResult = value;
      this.lastError = undefined;
      if (this.state !== "stopped") this.state = "running";
      return { kind: "ok", value };
    } catch (cause) {
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      if (this.state !== "stopped") this.state = "degraded";
      return ingestFailure(cause);
    } finally {
      this.inFlight = undefined;
    }
  }

  routePending(): Promise<Outcome<DeliveryRunResult>> {
    if (this.deliveryInFlight !== undefined) return this.deliveryInFlight;
    this.deliveryInFlight = this.runDelivery();
    return this.deliveryInFlight;
  }

  private async runDelivery(): Promise<Outcome<DeliveryRunResult>> {
    try {
      if (!this.deliveryComposed()) throw new Error('Messaging delivery dependencies are not composed');
      await this.addressedDeliveries.reconcile(this.options.store);
      const value = await routePendingDeliveries({
        store: this.options.store,
        agents: this.options.agentDirectory!,
        conversations: this.options.conversations!,
        providerSend: this.options.providerSend!,
        now: this.clock,
      });
      this.lastDeliveryRunAt = this.clock();
      return { kind: 'ok', value };
    } catch (cause) {
      return unavailable(cause);
    } finally {
      this.deliveryInFlight = undefined;
    }
  }

  private deliveryComposed(): boolean {
    return this.options.agentDirectory !== undefined
      && this.options.providerSend !== undefined
      && this.options.conversations !== undefined;
  }

  async listProviderSessions(): Promise<Outcome<readonly ProviderSession[]>> {
    try {
      return { kind: "ok" as const, value: await this.options.store.listProviderSessions() };
    } catch (cause) {
      return unavailable(cause);
    }
  }

  async sendConversationMessage(
    input: ConversationSendInput,
  ): Promise<Outcome<ConversationSendAcceptance>> {
    try {
      if (this.options.agentDirectory === undefined || this.options.providerSend === undefined) {
        throw new Error("Messaging send dependencies are not composed");
      }
      const value = await sendConversationMessage({
        store: this.options.store,
        agentDirectory: this.options.agentDirectory,
        providerSend: this.options.providerSend,
        now: this.clock,
      }, input);
      return { kind: "ok", value };
    } catch (cause) {
      return unavailable(cause);
    }
  }

  async listTranscriptLines(input?: unknown): Promise<Outcome<readonly TranscriptLine[]>> {
    try {
      const value = await this.options.store.listTranscriptLines(lineQuery(input));
      return { kind: "ok" as const, value };
    } catch (cause) {
      return unavailable(cause);
    }
  }


  async listSendJournals(): Promise<Outcome<readonly SendJournal[]>> {
    try {
      return { kind: "ok", value: await this.options.store.listSendJournals() };
    } catch (cause) {
      return unavailable(cause);
    }
  }

  async listAgentCommunications(
    input: AgentCommunicationsQuery,
  ): Promise<Outcome<AgentCommunicationPage>> {
    try {
      return { kind: 'ok' as const, value: await communicationQuery(this.options.store, input) };
    } catch (cause) {
      return unavailable(cause);
    }
  }

  subscribeTranscriptEvents(sink: Parameters<DurableTranscriptEventBus["subscribe"]>[0]) {
    return this.eventBus.subscribe(sink);
  }
}

/** Creates the 1-second, single-flight Messaging ingestion runtime. */
export function createMessagingRuntime(
  options: MessagingRuntimeOptions,
): MessagingRuntimeApi & { readonly eventBus: DurableTranscriptEventBus } {
  return new IngestionRuntime(options);
}
