import type { IngestCheckpoint } from "../records/ingest-checkpoint.js";
import type { ProviderSession } from "../records/provider-session.js";
import type { TranscriptLine } from "../records/transcript-line.js";
import type {
  EventCursor,
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

/** Atomic transcript-first persistence inside the canonical Messaging store. */
export interface TranscriptStore {
  getCheckpoint(sourceId: TranscriptSourceId): Promise<IngestCheckpoint | null>;
  commitIngestBatch(input: TranscriptBatchInput): Promise<TranscriptBatchResult>;
  listProviderSessions(): Promise<readonly ProviderSession[]>;
  listTranscriptLines(query?: TranscriptLineQuery): Promise<readonly TranscriptLine[]>;
  scanTranscriptEvents(after?: EventCursor, limit?: number): Promise<readonly TranscriptEvent[]>;
  close(): Promise<void>;
}
