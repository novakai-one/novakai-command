import type {
  PendingDeliveryId,
  PendingDeliveryState,
  Timestamp,
  TranscriptLineId,
} from '../types.js';

/** One transcript-addressed Agent delivery and its monotonic effect state. */
export interface PendingDelivery {
  readonly id: PendingDeliveryId;
  readonly kind: 'pending-delivery';
  readonly schemaVersion: 1;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly transcriptLineId: TranscriptLineId;
  readonly recipientAgentId: string;
  readonly state: PendingDeliveryState;
  readonly failure?: string;
}
