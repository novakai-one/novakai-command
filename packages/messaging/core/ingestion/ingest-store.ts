import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type {
  TranscriptBatchInput,
  TranscriptBatchResult,
} from '../../contract/ports/transcript-store.js';
import type { ProviderSessionId, Timestamp, TranscriptSourceId } from '../../contract/types.js';
import type { ConfirmStore } from '../send/confirm.js';

/**
 * Ingestion's consumer-owned store surfaces, narrowest first. The fat
 * TranscriptStore port has ~22 methods; no ingestion collaborator needs more
 * than the handful declared here, and each declares exactly its own.
 */

/** The store surface session assignment writes through. */
export interface AssignmentStore {
  upsertProviderSession(session: ProviderSession): Promise<ProviderSession>;
  bindAgentSession(agentId: string, sessionId: ProviderSessionId, updatedAt: Timestamp): Promise<number>;
}

/** The store surface classification reads and writes through. */
export interface ClassificationStore extends AssignmentStore {
  listSendJournals(): Promise<readonly SendJournal[]>;
}

/** The store surface one ingestion pass reads and writes through. */
export interface IngestionStore extends ClassificationStore, ConfirmStore {
  listProviderSessions(): Promise<readonly ProviderSession[]>;
  getCheckpoint(sourceId: TranscriptSourceId): Promise<IngestCheckpoint | null>;
  commitIngestBatch(input: TranscriptBatchInput): Promise<TranscriptBatchResult>;
}
