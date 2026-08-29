import type { SendStore } from '../send/send-store.js';
import type {
  AcceptPendingDeliveryInput,
  AcceptPendingDeliveryResult,
  PendingDeliveryTransitionInput,
  PendingDeliveryTransitionResult,
  TranscriptEvent,
} from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { EventCursor } from '../../contract/types.js';

/**
 * The slice of the canonical store the delivery router needs: pending-delivery
 * reads and compare-and-set writes, plus the transcript line and send journal
 * evidence a pass consults. It extends SendStore because routing hands each
 * claimed delivery to the send slice, which speaks through that narrower
 * contract — so the router's port is exactly its own four methods plus the
 * four it passes through. The full TranscriptStore satisfies this
 * structurally; tests fake eight methods instead of twenty-two.
 */
export interface DeliveryStore extends SendStore {
  listPendingDeliveries(): Promise<readonly PendingDelivery[]>;
  transitionPendingDelivery(
    input: PendingDeliveryTransitionInput,
  ): Promise<PendingDeliveryTransitionResult>;
  listSendJournals(): Promise<readonly SendJournal[]>;
  getTranscriptLine(id: TranscriptLine['id']): Promise<TranscriptLine | null>;
}

/**
 * The slice of the canonical store the addressed-delivery reconciler needs:
 * scan the durable event stream, read the lines its events point at, and
 * queue deliveries idempotently. The full TranscriptStore satisfies this
 * structurally.
 */
export interface DeliveryReconcilerStore {
  scanTranscriptEvents(after?: EventCursor, limit?: number): Promise<readonly TranscriptEvent[]>;
  listTranscriptLines(): Promise<readonly TranscriptLine[]>;
  acceptPendingDelivery(input: AcceptPendingDeliveryInput): Promise<AcceptPendingDeliveryResult>;
}
