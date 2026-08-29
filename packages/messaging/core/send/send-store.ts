import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type {
  AcceptSendInput,
  AcceptSendResult,
  SendTransitionInput,
  SendTransitionResult,
} from '../../contract/ports/transcript-store.js';
import type { TranscriptSourceId } from '../../contract/types.js';

/**
 * The slice of the canonical store the send path needs: two journal writes,
 * plus the session and checkpoint reads that fence a dispatch. The full
 * TranscriptStore satisfies this structurally; tests fake four methods
 * instead of twenty-two.
 */
export interface SendStore {
  acceptSend(input: AcceptSendInput): Promise<AcceptSendResult>;
  transitionSend(input: SendTransitionInput): Promise<SendTransitionResult>;
  listProviderSessions(): Promise<readonly ProviderSession[]>;
  getCheckpoint(sourceId: TranscriptSourceId): Promise<IngestCheckpoint | null>;
}
