import type { Outcome } from "./outcome.js";
import type { ProviderSession } from "./records/provider-session.js";
import type { TranscriptLine } from "./records/transcript-line.js";
import type { SendJournal } from "./records/send-journal.js";
import type { ConversationSendAcceptance, ConversationSendInput } from "./commands.js";
import type { TranscriptEvent } from "./ports/transcript-store.js";
import type { AgentCommunicationPage, AgentCommunicationsQuery } from './communications.js';
import type {
  AgentConversationMessage,
  AgentConversationMessageSink,
  AgentConversationMessagesQuery,
  EnsureConversationViewInput,
  UpdateConversationViewInput,
} from './conversations.js';
import type { ConversationView } from './records/conversation-view.js';
import type { ProjectionRebuildResult } from './records/projections.js';
import type {
  AgentDeliveryInstruction, AgentDeliveryMarker,
} from './agent-delivery-marker.js';

/** Counts from one idle-boundary delivery pass. */
export interface DeliveryRunResult {
  readonly claimed: number;
  readonly deferredBusy: number;
  readonly submitted: number;
  readonly failed: number;
  readonly observed: number;
}

/**
 * Why one provider source failed to ingest, so hosts branch on the kind
 * instead of parsing the message. `ambiguous-evidence` means the file named
 * more than one session; `session-conflict` means its identity evidence
 * contradicts itself; `agent-unknown` means it names an Agent the directory
 * does not know; `dependency-unavailable` means a required collaborator was
 * not composed; `unexpected` is anything else — the message keeps the detail.
 */
export type IngestFailureKind =
  | 'ambiguous-evidence'
  | 'session-conflict'
  | 'agent-unknown'
  | 'dependency-unavailable'
  | 'unexpected';

/** One provider source that failed this pass, with typed evidence for hosts. */
export interface IngestSourceFailure {
  readonly sourceId: string;
  readonly provider: string;
  readonly kind: IngestFailureKind;
  readonly message: string;
}

export interface IngestResult {
  readonly sources: number;
  readonly added: number;
  readonly duplicates: number;
  readonly sessionsRegistered: number;
  readonly sessionsAdopted: number;
  readonly foreignSources: number;
  readonly failedSources: number;
  readonly failures: readonly IngestSourceFailure[];
}

/** Observable lifecycle and most recent result for the ingest runtime. */
export interface MessagingHealth {
  readonly state: "stopped" | "running" | "degraded";
  readonly ingesting: boolean;
  readonly runs: number;
  readonly lastResult?: IngestResult;
  readonly lastError?: string;
  readonly lastDeliveryRunAt?: string;
  readonly pendingDeliveryCount: number;
}

/** Host-facing control and committed-query surface for transcript ingestion. */
export interface MessagingRuntimeApi {
  start(): Promise<Outcome<void>>;
  stop(): Promise<Outcome<void>>;
  health(): Promise<MessagingHealth>;
  ingestNow(): Promise<Outcome<IngestResult>>;
  routePending(): Promise<Outcome<DeliveryRunResult>>;
  ensureConversationView(input: EnsureConversationViewInput): Promise<Outcome<ConversationView>>;
  updateConversationView(input: UpdateConversationViewInput): Promise<Outcome<ConversationView>>;
  getConversationView(id: string): Promise<Outcome<ConversationView | null>>;
  listConversationViews(): Promise<Outcome<readonly ConversationView[]>>;
  rebuildProjections(): Promise<Outcome<ProjectionRebuildResult>>;
  readProjections(): Promise<Outcome<ProjectionRebuildResult>>;
  createAgentDeliveryInstruction(
    input: AgentDeliveryMarker,
  ): Promise<Outcome<AgentDeliveryInstruction>>;
  sendConversationMessage(input: ConversationSendInput): Promise<Outcome<ConversationSendAcceptance>>;
  listProviderSessions(): Promise<Outcome<readonly ProviderSession[]>>;
  listTranscriptLines(input?: unknown): Promise<Outcome<readonly TranscriptLine[]>>;
  listAgentConversationMessages(
    input: AgentConversationMessagesQuery,
  ): Promise<Outcome<readonly AgentConversationMessage[]>>;
  subscribeAgentConversationMessages(
    sink: AgentConversationMessageSink,
  ): { close(): void };
  listSendJournals(): Promise<Outcome<readonly SendJournal[]>>;
  listAgentCommunications(
    input: AgentCommunicationsQuery,
  ): Promise<Outcome<AgentCommunicationPage>>;
  subscribeTranscriptEvents(
    sink: (event: TranscriptEvent) => void | Promise<void>,
  ): { close(): void };
}
