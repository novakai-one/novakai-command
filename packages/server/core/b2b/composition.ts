import {
  createDefaultMessagingRuntime,
  type IngestResult,
  type MessagingHealth,
  type MessagingRuntimeApi,
  type ExternalAdoptionOptions,
  type Outcome,
  type TranscriptLine,
} from "../../../messaging/contract/index.js";
import type { AgentDirectory } from "../../../messaging/contract/index.js";
import type { ProviderSend } from "../../../messaging/contract/index.js";

const DEFAULT_POLL_MS = 1_000;

/** Compatibility result projected from target Messaging ingestion. */
export interface LegacyTranscriptResult {
  readonly added: number;
  readonly duplicates: number;
  readonly skipped: readonly unknown[];
  readonly diagnostics: readonly unknown[];
}

interface LegacyTranscriptError {
  readonly code: "TranscriptSourceFailed";
  readonly message: string;
  readonly details: { readonly cause: string };
  readonly retryable: boolean;
}

type LegacyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LegacyTranscriptError };

type LegacyTranscriptLine = Omit<TranscriptLine, "kind"> & {
  readonly kind: "transcriptLine";
  readonly permissionLevel: "private";
  readonly createdBy: string;
  readonly sourceAttribution: { readonly origin: string; readonly ingestedAt: string };
  readonly sourceId: string;
  readonly sourceOffset: number;
  readonly dedupKey: string;
  readonly sessionRef: string;
};

interface LegacyIngestionStatus {
  readonly running: boolean;
  readonly idle: boolean;
  readonly lastError: string | null;
  readonly latched: boolean;
}

/** Observable state of the compatibility watcher facade. */
export interface TranscriptTopologyStatus {
  running: boolean;
  watcherReady: boolean;
  ingesting: boolean;
  runs: number;
  lastResult?: LegacyTranscriptResult;
  lastError?: string;
}

/** Legacy read/trigger operations backed only by target Messaging. */
export interface TranscriptServerOperations {
  ingest(): Promise<LegacyResult<LegacyTranscriptResult>>;
  status(): Promise<LegacyResult<LegacyIngestionStatus>>;
  linesBySession(sessionRef: string): Promise<LegacyResult<readonly LegacyTranscriptLine[]>>;
  linesByProvider(
    provider: "claude" | "codex" | "kimi",
    since?: string,
  ): Promise<LegacyResult<readonly LegacyTranscriptLine[]>>;
  subagentTree(turnId: string): Promise<LegacyResult<readonly LegacyTranscriptLine[]>>;
}

/** Lifecycle facade around the target Messaging watcher. */
export interface TranscriptTopology {
  start(): void;
  stop(): Promise<void>;
  trigger(): Promise<LegacyResult<LegacyTranscriptResult>>;
  status(): TranscriptTopologyStatus;
}

/** Server composition result exposing target runtime and temporary facades. */
export interface TranscriptServerHost {
  readonly operations: TranscriptServerOperations;
  readonly topology: TranscriptTopology;
  readonly runtime: MessagingRuntimeApi;
}

/** Dependencies and cadence accepted by the Server composition seam. */
export interface ComposeTranscriptServerHostOptions {
  root: string;
  providerHome?: string;
  watcherIntervalMs?: number;
  ingestIntervalMs?: number;
  agentDirectory?: AgentDirectory;
  providerSend?: ProviderSend;
  externalAdoption?: ExternalAdoptionOptions;
  conversations?: import('../../../messaging/contract/index.js').ConversationDirectory;
  conversationPrincipalId?: string;
}

const legacyLine = (line: TranscriptLine): LegacyTranscriptLine => ({
  ...line,
  kind: "transcriptLine" as const,
  permissionLevel: "private" as const,
  createdBy: "sys_messaging",
  sourceAttribution: {
    origin: `${line.provider}:${line.sourcePosition.sourceId}`,
    ingestedAt: line.createdAt,
  },
  sourceId: line.sourcePosition.sourceId,
  sourceOffset: line.sourcePosition.offset,
  dedupKey: line.id,
  sessionRef: line.sessionId,
});

const oldResult = (value: IngestResult): LegacyTranscriptResult => ({
  added: value.added,
  duplicates: value.duplicates,
  skipped: [],
  diagnostics: [],
});

const oldOutcome = <T>(outcome: Outcome<T>): LegacyResult<T> => outcome.kind === "ok"
  ? { ok: true, value: outcome.value }
  : {
      ok: false,
      error: {
        code: "TranscriptSourceFailed",
        message: outcome.error.message,
        details: { cause: "Messaging ingestion unavailable" },
        retryable: outcome.error.retryable,
      },
    };

/** Temporary wire compatibility; all provider-file authority is in Messaging. */
export function composeTranscriptServerHost(
  options: ComposeTranscriptServerHostOptions,
): TranscriptServerHost {
  const state: TranscriptTopologyStatus = {
    running: false,
    watcherReady: false,
    ingesting: false,
    runs: 0,
  };
  const ready = createDefaultMessagingRuntime({
      root: options.root,
      ...(options.providerHome === undefined ? {} : { providerHome: options.providerHome }),
      intervalMs: options.ingestIntervalMs ?? options.watcherIntervalMs ?? DEFAULT_POLL_MS,
      ...(options.agentDirectory === undefined ? {} : { agentDirectory: options.agentDirectory }),
      ...(options.providerSend === undefined ? {} : { providerSend: options.providerSend }),
      ...(options.conversations === undefined ? {} : { conversations: options.conversations }),
      ...(options.conversationPrincipalId === undefined
        ? {} : { conversationPrincipalId: options.conversationPrincipalId }),
      ...(options.externalAdoption === undefined
        ? {} : { externalAdoption: options.externalAdoption }),
  });

  const ingest = async (): Promise<Outcome<IngestResult>> => {
    state.ingesting = true;
    const outcome = await (await ready).runtime.ingestNow();
    state.ingesting = false;
    state.runs += 1;
    if (outcome.kind === "ok") {
      state.lastResult = oldResult(outcome.value);
      delete state.lastError;
    } else state.lastError = outcome.error.message;
    return outcome;
  };

  const runtime: MessagingRuntimeApi = {
    async start() {
      const outcome = await (await ready).runtime.start();
      state.running = outcome.kind === "ok";
      state.watcherReady = outcome.kind === "ok";
      if (outcome.kind === "error") state.lastError = outcome.error.message;
      return outcome;
    },
    async stop() {
      const composed = await ready;
      const outcome = await composed.runtime.stop();
      await composed.close();
      state.running = false;
      state.watcherReady = false;
      return outcome;
    },
    health: async (): Promise<MessagingHealth> => (await ready).runtime.health(),
    ingestNow: ingest,
    routePending: async () => (await ready).runtime.routePending(),
    ensureConversationView: async (input) =>
      (await ready).runtime.ensureConversationView(input),
    updateConversationView: async (input) =>
      (await ready).runtime.updateConversationView(input),
    getConversationView: async (id) => (await ready).runtime.getConversationView(id),
    listConversationViews: async () => (await ready).runtime.listConversationViews(),
    rebuildProjections: async () => (await ready).runtime.rebuildProjections(),
    readProjections: async () => (await ready).runtime.readProjections(),
    sendConversationMessage: async (input) =>
      (await ready).runtime.sendConversationMessage(input),
    listProviderSessions: async () => (await ready).runtime.listProviderSessions(),
    listTranscriptLines: async (input?: unknown) => (await ready).runtime.listTranscriptLines(input),
    listSendJournals: async () => (await ready).runtime.listSendJournals(),
    listAgentCommunications: async (input) =>
      (await ready).runtime.listAgentCommunications(input),
    subscribeTranscriptEvents(sink) {
      let closed = false;
      let subscription: { close(): void } | undefined;
      void ready.then((composed) => {
        if (!closed) subscription = composed.runtime.subscribeTranscriptEvents(sink);
      });
      return {
        close() {
          closed = true;
          subscription?.close();
        },
      };
    },
  };

  const operations: TranscriptServerOperations = {
    ingest: async () => {
      const outcome = await ingest();
      return outcome.kind === "ok"
        ? { ok: true, value: oldResult(outcome.value) }
        : oldOutcome(outcome);
    },
    status: async () => ({
      ok: true,
      value: {
        running: state.ingesting,
        idle: !state.ingesting,
        lastError: state.lastError ?? null,
        latched: false,
      },
    }),
    async linesBySession(sessionRef) {
      const outcome = await runtime.listTranscriptLines({ sessionId: sessionRef });
      return outcome.kind === "ok"
        ? { ok: true, value: outcome.value.map(legacyLine) }
        : oldOutcome(outcome);
    },
    async linesByProvider(provider, since) {
      const outcome = await runtime.listTranscriptLines({ provider });
      if (outcome.kind !== "ok") return oldOutcome(outcome);
      const threshold = since === undefined ? undefined : Date.parse(since);
      const lines = outcome.value.filter((line) =>
        threshold === undefined || Date.parse(line.createdAt) >= threshold);
      return { ok: true, value: lines.map(legacyLine) };
    },
    async subagentTree(turnId) {
      const outcome = await runtime.listTranscriptLines();
      if (outcome.kind !== "ok") return oldOutcome(outcome);
      const descendants: TranscriptLine[] = [];
      const queue = [turnId];
      while (queue.length > 0) {
        const parent = queue.shift();
        for (const line of outcome.value) {
          if (line.parentTurnId !== parent || descendants.includes(line)) continue;
          descendants.push(line);
          if (line.turnId !== undefined) queue.push(line.turnId);
        }
      }
      return { ok: true, value: descendants.map(legacyLine) };
    },
  };

  const topology: TranscriptTopology = {
    start: () => { void runtime.start(); },
    stop: async () => { await runtime.stop(); },
    trigger: async () => {
      const outcome = await ingest();
      return outcome.kind === "ok"
        ? { ok: true, value: oldResult(outcome.value) }
        : oldOutcome(outcome);
    },
    status: () => ({ ...state }),
  };
  return { operations, topology, runtime };
}
