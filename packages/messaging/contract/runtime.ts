import type { Outcome } from "./outcome.js";
import type { ProviderSession } from "./records/provider-session.js";
import type { TranscriptLine } from "./records/transcript-line.js";
import type { SendJournal } from "./records/send-journal.js";
import type { ConversationSendAcceptance, ConversationSendInput } from "./commands.js";
import type { TranscriptEvent } from "./ports/transcript-store.js";
import type { AgentCommunicationPage, AgentCommunicationsQuery } from './communications.js';
import type {
  EnsureConversationViewInput,
  UpdateConversationViewInput,
} from './conversations.js';
import type { ConversationView } from './records/conversation-view.js';
import type { ProjectionRebuildResult } from './records/projections.js';

/** Counts from one idle-boundary delivery pass. */
export interface DeliveryRunResult {
  readonly claimed: number;
  readonly deferredBusy: number;
  readonly submitted: number;
  readonly failed: number;
  readonly observed: number;
}

/** Counts returned by one provider-source scan and commit pass. */
export interface IngestResult {
  readonly sources: number;
  readonly added: number;
  readonly duplicates: number;
  readonly sessionsRegistered: number;
  readonly sessionsAdopted: number;
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
  sendConversationMessage(input: ConversationSendInput): Promise<Outcome<ConversationSendAcceptance>>;
  listProviderSessions(): Promise<Outcome<readonly ProviderSession[]>>;
  listTranscriptLines(input?: unknown): Promise<Outcome<readonly TranscriptLine[]>>;
  listSendJournals(): Promise<Outcome<readonly SendJournal[]>>;
  listAgentCommunications(
    input: AgentCommunicationsQuery,
  ): Promise<Outcome<AgentCommunicationPage>>;
  subscribeTranscriptEvents(
    sink: (event: TranscriptEvent) => void | Promise<void>,
  ): { close(): void };
}
