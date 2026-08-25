import type { TranscriptBatchInput } from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';

/** Closed payload catalogue persisted in the canonical Messaging store. */
export type MessagingStoreOp =
  | { readonly op: 'transcript-ingest'; readonly batch: TranscriptBatchInput }
  | { readonly op: 'provider-session-upsert'; readonly session: ProviderSession }
  | { readonly op: 'send-journal-mutation'; readonly journals: readonly SendJournal[] }
  | { readonly op: 'pending-delivery-mutation'; readonly deliveries: readonly PendingDelivery[] };

/** Foundation envelope around one replayable Messaging operation. */
export interface MessagingStoreRecord {
  readonly kind: 'messagingStoreOp';
  readonly id: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly permissionLevel: 'private';
  readonly createdBy: string;
  readonly storeSequence: number;
  readonly transcriptSequence?: number;
  readonly sendSequence?: number;
  readonly deliverySequence?: number;
  readonly operationKey: string;
  readonly payloadDigest: string;
  readonly storeOp: MessagingStoreOp;
}

/** Rejects unknown historical payloads without inventing replay meaning. */
export function messagingStoreRecord(value: unknown): MessagingStoreRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<MessagingStoreRecord>;
  if (record.kind !== 'messagingStoreOp'
    || typeof record.operationKey !== 'string'
    || typeof record.payloadDigest !== 'string'
    || typeof record.storeOp !== 'object'
    || record.storeOp === null) return undefined;
  const op = (record.storeOp as { op?: unknown }).op;
  return op === 'transcript-ingest' || op === 'provider-session-upsert'
    || op === 'send-journal-mutation' || op === 'pending-delivery-mutation'
    ? record as MessagingStoreRecord : undefined;
}
