import type { IngestCheckpoint } from "../records/ingest-checkpoint.js";
import type { ProviderSession } from "../records/provider-session.js";
import type { TranscriptLine } from "../records/transcript-line.js";
import type { SendAttempt, SendJournal } from "../records/send-journal.js";
import type { PendingDelivery } from '../records/pending-delivery.js';
import type {
  EventCursor,
  PendingDeliveryState,
  ProviderName,
  ProviderResumeId,
  ProviderSessionId,
  TranscriptEventKind,
  TranscriptSourceId,
} from "../types.js";

/** All records committed atomically for one source growth read. */
export interface TranscriptBatchInput {
  readonly expectedCheckpoint: IngestCheckpoint | null;
  readonly session: ProviderSession;
  readonly lines: readonly TranscriptLine[];
  readonly checkpoint: IngestCheckpoint;
}

/** Idempotency outcome from an atomic ingest commit. */
export interface TranscriptBatchResult {
  readonly added: number;
  readonly duplicates: number;
  readonly checkpoint: IngestCheckpoint;
}

/** Durable post-commit notification derived from authoritative records. */
export interface TranscriptEvent {
  readonly cursor: EventCursor;
  readonly kind: TranscriptEventKind;
  readonly sessionId: ProviderSessionId;
  readonly transcriptLineId?: TranscriptLine["id"];
}

/** Supported committed-line filters; omitted fields are unconstrained. */
export interface TranscriptLineQuery {
  readonly sessionId?: ProviderSessionId;
  readonly provider?: ProviderName;
  readonly sourceId?: TranscriptSourceId;
  readonly resumeId?: ProviderResumeId;
}

/** Idempotent durable acceptance before any provider effect. */
export interface AcceptSendInput {
  readonly journal: SendJournal;
}

/** Existing or newly committed idempotent SendJournal. */
export interface AcceptSendResult {
  readonly journal: SendJournal;
  readonly duplicate: boolean;
}

/** Compare-and-transition one journal and optional attempt. */
export interface SendTransitionInput {
  readonly sendId: SendJournal['id'];
  readonly expectedState: SendJournal['state'];
  readonly state: SendJournal['state'];
  readonly updatedAt: SendJournal['updatedAt'];
  readonly attempt?: SendAttempt;
}

/** Result of one compare-and-transition request. */
export interface SendTransitionResult {
  readonly journal: SendJournal;
  readonly changed: boolean;
}

/** Idempotent creation of one transcript-addressed delivery. */
export interface AcceptPendingDeliveryInput {
  readonly delivery: PendingDelivery;
}

/** Compare-and-transition one PendingDelivery. */
export interface PendingDeliveryTransitionInput {
  readonly id: PendingDelivery['id'];
  readonly expectedState: PendingDeliveryState;
  readonly state: PendingDeliveryState;
  readonly updatedAt: string;
  readonly failure?: string;
}

/** Current delivery plus whether this invocation changed it. */
export interface PendingDeliveryTransitionResult {
  readonly delivery: PendingDelivery;
  readonly changed: boolean;
}

/** Atomic transcript-first persistence inside the canonical Messaging store. */
export interface TranscriptStore {
  getCheckpoint(sourceId: TranscriptSourceId): Promise<IngestCheckpoint | null>;
  upsertProviderSession(session: ProviderSession): Promise<ProviderSession>;
  commitIngestBatch(input: TranscriptBatchInput): Promise<TranscriptBatchResult>;
  listProviderSessions(): Promise<readonly ProviderSession[]>;
  listTranscriptLines(query?: TranscriptLineQuery): Promise<readonly TranscriptLine[]>;
  acceptSend(input: AcceptSendInput): Promise<AcceptSendResult>;
  transitionSend(input: SendTransitionInput): Promise<SendTransitionResult>;
  bindAgentSession(agentId: string, sessionId: ProviderSessionId, updatedAt: string): Promise<number>;
  confirmSendForLines(sessionId: ProviderSessionId, lines: readonly TranscriptLine[], updatedAt: string): Promise<number>;
  listSendJournals(): Promise<readonly SendJournal[]>;
  acceptPendingDelivery(input: AcceptPendingDeliveryInput): Promise<PendingDelivery>;
  transitionPendingDelivery(
    input: PendingDeliveryTransitionInput,
  ): Promise<PendingDeliveryTransitionResult>;
  listPendingDeliveries(): Promise<readonly PendingDelivery[]>;
  scanTranscriptEvents(after?: EventCursor, limit?: number): Promise<readonly TranscriptEvent[]>;
  close(): Promise<void>;
}
