import type { Outcome } from "../../contract/outcome.js";
import type {
  IngestResult,
  DeliveryRunResult,
  MessagingHealth,
  MessagingRuntimeApi,
} from "../../contract/runtime.js";
import type {
  ProviderNormalizer,
  ProviderSourceSubscription,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type { TranscriptStore } from "../../contract/ports/transcript-store.js";
import type { ProviderName, TranscriptSourceId } from "../../contract/types.js";
import { MessagingError } from "../../contract/types.js";
import type { MessagingTraceSink } from "../../contract/trace.js";
import { createDurableTranscriptEventBus, type DurableTranscriptEventBus } from "../event-bus.js";
import { brandClock } from "../clock.js";
import { thrownMessage, thrownMessageOr } from "../thrown.js";
import { emitTrace } from "../trace.js";
import { present } from "../send/sparse.js";
import { runIngestionPass } from "../ingestion/ingest.js";
import type {
  AdoptionAssignment,
  AgentDirectory,
} from "../../contract/ports/agent-directory.js";
import type { ConversationDirectory } from "../../contract/ports/conversation-directory.js";
import type { ProviderSend } from "../../contract/ports/provider-send.js";
import { AmbiguousProviderSessionEvidenceError } from "../ingestion/reconcile.js";
import { createStoredConversationDirectory } from '../conversations/directory.js';
import { createCommittedRecordsApi } from './committed-records.js';
import { subscribeAgentConversationMessageStream } from '../conversations/message-stream.js';
import { ProviderIngestQueue } from '../ingestion/ingest-queue.js';
import { DeliveryRuntime } from '../ingestion/delivery-runtime.js';

/**
 * Configures provider ingestion and delivery scheduling. Maintenance defaults
 * to one second and remains the polling cadence for sources without complete
 * event support; safety discovery defaults to 60 seconds and source changes
 * are coalesced for 25 milliseconds by default.
 */
export interface MessagingRuntimeOptions {
  readonly store: TranscriptStore;
  readonly source: ProviderTranscriptSource;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly now?: () => string;
  readonly intervalMs?: number;
  readonly safetySweepMs?: number;
  readonly changeDebounceMs?: number;
  readonly eventBus?: DurableTranscriptEventBus;
  readonly trace?: MessagingTraceSink;
  readonly agentDirectory?: AgentDirectory;
  readonly providerSend?: ProviderSend;
  readonly conversations?: ConversationDirectory;
  readonly conversationPrincipalId?: string;
  readonly adoption?: {
    readonly assignment: AdoptionAssignment;
    readonly conversations?: ConversationDirectory;
    readonly limitPerTick: number;
  };
  readonly storeId?: string;
}

const unavailable = <T>(cause: unknown): Outcome<T> => ({
  kind: "error",
  error: new MessagingError("DependencyUnavailable", {
    message: thrownMessageOr(cause, "Messaging ingestion unavailable"),
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

/**
 * A source is event-driven only when it can both watch for changes and stat
 * the sources a change names; one capability without the other means polling.
 */
function eventSupport(source: ProviderTranscriptSource): {
  watchChanges: NonNullable<ProviderTranscriptSource['watchChanges']>;
  statKnown: NonNullable<ProviderTranscriptSource['statKnown']>;
} | undefined {
  if (source.watchChanges === undefined || source.statKnown === undefined) return undefined;
  return { watchChanges: source.watchChanges, statKnown: source.statKnown };
}

/**
 * The composed messaging runtime: the constructor is the wiring, `start`/`stop`
 * own the lifecycle, and every ingestion trigger converges on `runPass` — one
 * ingestion pass (see ingestion/ingest.ts), then delivery drains what it
 * committed.
 */
class MessagingRuntime implements MessagingRuntimeApi {
  readonly eventBus: DurableTranscriptEventBus;
  private readonly clock: () => string;
  private readonly intervalMs: number;
  private readonly safetySweepMs: number;
  private readonly discoveryFloor: string;
  private state: MessagingHealth["state"] = "stopped";
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  private safetyTimer: ReturnType<typeof setInterval> | undefined;
  private sourceSubscription: ProviderSourceSubscription | undefined;
  private runs = 0;
  private lastResult: IngestResult | undefined;
  private lastError: string | undefined;
  private readonly ingestQueue: ProviderIngestQueue;
  private readonly delivery: DeliveryRuntime;
  private readonly conversations: ConversationDirectory | undefined;
  private readonly records: ReturnType<typeof createCommittedRecordsApi>;

  constructor(private readonly options: MessagingRuntimeOptions) {
    this.clock = options.now ?? (() => new Date().toISOString());
    this.intervalMs = options.intervalMs ?? 1_000;
    this.safetySweepMs = options.safetySweepMs ?? 60_000;
    this.ingestQueue = new ProviderIngestQueue(
      options.changeDebounceMs ?? 25,
      (sourceIds) => this.runPass(sourceIds),
    );
    this.discoveryFloor = this.clock();
    this.eventBus = options.eventBus ?? createDurableTranscriptEventBus(options.store, options.trace);
    this.conversations = options.conversations ?? options.adoption?.conversations
      ?? (options.conversationPrincipalId === undefined
      ? undefined
      : createStoredConversationDirectory({
          store: options.store,
          humanPrincipalId: options.conversationPrincipalId,
          now: brandClock(this.clock),
        }));
    this.delivery = new DeliveryRuntime({
      store: options.store,
      now: this.clock,
      ...present('agents', options.agentDirectory),
      ...present('providerSend', options.providerSend),
      ...present('conversations', this.conversations),
    });
    this.records = createCommittedRecordsApi({
      store: options.store,
      now: this.clock,
      normalizers: options.normalizers,
      ...present('agentDirectory', options.agentDirectory),
      ...present('providerSend', options.providerSend),
      ...present('trace', options.trace),
    });
  }

  /**
   * Starts ingestion and runs the first pass. A failed first pass does not
   * fail `start` — it lands in `health()` as `degraded` with `lastError`,
   * and the maintenance timer retries on the next tick.
   */
  async start(): Promise<Outcome<void>> {
    if (this.state !== "stopped") return { kind: "ok", value: undefined };
    this.state = "running";
    await this.subscribeToChanges();
    this.scheduleTimers();
    await this.ingestNow();
    return { kind: "ok", value: undefined };
  }

  /** Event-driven ingestion when the source supports it; polling falls to the timer. */
  private async subscribeToChanges(): Promise<void> {
    const events = eventSupport(this.options.source);
    if (events === undefined) return;
    try {
      this.sourceSubscription = await events.watchChanges((change) => {
        if (this.state !== 'stopped') this.ingestQueue.notify(change);
      });
    } catch (cause) {
      this.lastError = thrownMessage(cause);
    }
  }

  /** The maintenance tick always runs; the safety sweep only for event-driven sources. */
  private scheduleTimers(): void {
    this.maintenanceTimer = setInterval(() => {
      if (this.sourceSubscription === undefined) void this.ingestNow();
      else void this.runMaintenanceTick();
    }, this.intervalMs);
    this.maintenanceTimer.unref();
    if (this.sourceSubscription === undefined) return;
    this.safetyTimer = setInterval(() => { void this.ingestQueue.requestDiscovery(); }, this.safetySweepMs);
    this.safetyTimer.unref();
  }

  async stop(): Promise<Outcome<void>> {
    this.clearTimers();
    this.sourceSubscription?.close();
    this.sourceSubscription = undefined;
    this.ingestQueue.cancelPending();
    await this.ingestQueue.waitForIdle();
    await this.delivery.waitForIdle();
    this.state = "stopped";
    return { kind: "ok", value: undefined };
  }

  private clearTimers(): void {
    if (this.maintenanceTimer !== undefined) clearInterval(this.maintenanceTimer);
    if (this.safetyTimer !== undefined) clearInterval(this.safetyTimer);
    this.maintenanceTimer = undefined;
    this.safetyTimer = undefined;
  }

  /** Point-in-time runtime state; a store failure here propagates to the host caller. */
  async health(): Promise<MessagingHealth> {
    return {
      state: this.state,
      ingesting: this.ingestQueue.active,
      runs: this.runs,
      ...present('lastResult', this.lastResult),
      ...present('lastError', this.lastError),
      ...present('lastDeliveryRunAt', this.delivery.lastRunAt),
      pendingDeliveryCount: await this.pendingDeliveryCount(),
    };
  }

  /** Deliveries still owed to a recipient: queued, or claimed but not yet submitted. */
  private async pendingDeliveryCount(): Promise<number> {
    const pending = await this.options.store.listPendingDeliveries();
    return pending.filter((delivery) =>
      delivery.state === 'queued' || delivery.state === 'claimed').length;
  }

  /** Runs one full discovery pass now; failures return a typed outcome and mark the runtime `degraded`. */
  ingestNow(): Promise<Outcome<IngestResult>> {
    return this.ingestQueue.requestDiscovery();
  }

  private async runPass(
    sourceIds?: readonly TranscriptSourceId[],
  ): Promise<Outcome<IngestResult>> {
    try {
      return this.recordSuccess(await this.executePass(sourceIds));
    } catch (cause) {
      return this.recordFailure(cause);
    }
  }

  /** One ingestion pass, then delivery drains what it committed. */
  private async executePass(
    sourceIds: readonly TranscriptSourceId[] | undefined,
  ): Promise<IngestResult> {
    const value = await runIngestionPass({
      store: this.options.store,
      source: this.options.source,
      normalizers: this.options.normalizers,
      now: brandClock(this.clock),
      discoveryFloor: this.discoveryFloor,
      ...present('storeId', this.options.storeId),
      ...present('agentDirectory', this.options.agentDirectory),
      ...present('adoption', this.adoptionConfig()),
    }, await this.candidatesFor(sourceIds));
    await this.delivery.maintain(this.eventBus);
    emitTrace(this.options.trace, {
      stage: 'ingest.pass',
      detail: `sources=${value.sources} added=${value.added} duplicates=${value.duplicates} failed=${value.failedSources}`,
    });
    return value;
  }

  private recordSuccess(value: IngestResult): Outcome<IngestResult> {
    this.runs += 1;
    this.lastResult = value;
    this.lastError = undefined;
    if (this.state !== "stopped") this.state = "running";
    return { kind: "ok", value };
  }

  private recordFailure(cause: unknown): Outcome<IngestResult> {
    this.lastError = thrownMessage(cause);
    if (this.state !== "stopped") this.state = "degraded";
    emitTrace(this.options.trace, { stage: 'ingest.failed', detail: this.lastError });
    return ingestFailure(cause);
  }

  /** Stat the changed sources when the source supports it; otherwise a full pass. */
  private async candidatesFor(
    sourceIds: readonly TranscriptSourceId[] | undefined,
  ) {
    if (sourceIds === undefined) return undefined;
    const events = eventSupport(this.options.source);
    if (events === undefined) return undefined;
    return events.statKnown(sourceIds);
  }

  /** Adoption wiring only when both the assignment and a conversation directory exist. */
  private adoptionConfig() {
    if (this.options.adoption === undefined || this.conversations === undefined) return undefined;
    return { ...this.options.adoption, conversations: this.conversations };
  }

  private async runMaintenanceTick(): Promise<void> {
    if (this.state === 'stopped' || this.ingestQueue.active) return;
    try {
      await this.delivery.maintain(this.eventBus);
    } catch (cause) {
      this.lastError = thrownMessage(cause);
      this.state = 'degraded';
    }
  }

  /** Drains pending deliveries now; failures return a typed outcome, the queue is retried next tick. */
  routePending(): Promise<Outcome<DeliveryRunResult>> {
    return this.delivery.routePending();
  }

  ensureConversationView: MessagingRuntimeApi['ensureConversationView'] = (input) => this.records.ensureConversationView(input);
  updateConversationView: MessagingRuntimeApi['updateConversationView'] = (input) => this.records.updateConversationView(input);
  getConversationView: MessagingRuntimeApi['getConversationView'] = (id) => this.records.getConversationView(id);
  listConversationViews: MessagingRuntimeApi['listConversationViews'] = () => this.records.listConversationViews();
  rebuildProjections: MessagingRuntimeApi['rebuildProjections'] = () => this.records.rebuildProjections();
  readProjections: MessagingRuntimeApi['readProjections'] = () => this.records.readProjections();
  createAgentDeliveryInstruction: MessagingRuntimeApi['createAgentDeliveryInstruction'] = (input) => this.records.createAgentDeliveryInstruction(input);
  listProviderSessions: MessagingRuntimeApi['listProviderSessions'] = () => this.records.listProviderSessions();
  sendConversationMessage: MessagingRuntimeApi['sendConversationMessage'] = (input) => this.records.sendConversationMessage(input);
  listTranscriptLines: MessagingRuntimeApi['listTranscriptLines'] = (input) => this.records.listTranscriptLines(input);
  listAgentConversationMessages: MessagingRuntimeApi['listAgentConversationMessages'] = (input) => this.records.listAgentConversationMessages(input);
  listSendJournals: MessagingRuntimeApi['listSendJournals'] = () => this.records.listSendJournals();
  listAgentCommunications: MessagingRuntimeApi['listAgentCommunications'] = (input) => this.records.listAgentCommunications(input);

  subscribeAgentConversationMessages: MessagingRuntimeApi['subscribeAgentConversationMessages'] =
    (sink) => subscribeAgentConversationMessageStream({
      eventBus: this.eventBus,
      store: this.options.store,
      normalizers: this.options.normalizers,
      ...present('trace', this.options.trace),
    }, sink);

  subscribeTranscriptEvents(sink: Parameters<DurableTranscriptEventBus["subscribe"]>[0]) {
    return this.eventBus.subscribe(sink);
  }
}

/**
 * Creates the Messaging ingestion runtime, stopped. Sources that implement
 * `watchChanges` and `statKnown` get event-driven ingestion with a default 60s
 * safety sweep; other sources fall back to interval polling. `start` and `stop`
 * are idempotent; `stop` releases all timers and filesystem watchers.
 */
export function createMessagingRuntime(
  options: MessagingRuntimeOptions,
): MessagingRuntimeApi & { readonly eventBus: DurableTranscriptEventBus } {
  return new MessagingRuntime(options);
}
