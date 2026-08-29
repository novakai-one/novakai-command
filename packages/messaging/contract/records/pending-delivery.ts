import type { SendRejection } from '../commands.js';
import type {
  PendingDeliveryId,
  PendingDeliveryState,
  Timestamp,
  TranscriptLineId,
} from '../types.js';

/**
 * Why a delivery failed, as typed evidence — never a string to parse.
 * `send-rejected` carries the send slice's typed rejection whole;
 * `dispatch-failed` means the provider dispatch left no transcript evidence;
 * `routing-failed` means routing proved the delivery can never proceed;
 * `submission-error` means a throw during submission was caught at the
 * delivery boundary and reduced to its message.
 */
export type DeliveryFailure =
  | { readonly kind: 'send-rejected'; readonly rejection: SendRejection }
  | { readonly kind: 'dispatch-failed'; readonly detail: string }
  | { readonly kind: 'routing-failed'; readonly detail: string }
  | { readonly kind: 'submission-error'; readonly detail: string };

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
  readonly failure?: DeliveryFailure;
}
