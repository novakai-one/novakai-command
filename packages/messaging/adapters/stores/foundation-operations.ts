import type { TranscriptBatchInput } from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { ConversationViewMutation } from '../../contract/records/conversation-view.js';
import type { ProjectionRebuildResult } from '../../contract/records/projections.js';

/** Closed payload catalogue persisted in the canonical Messaging store. */
export type MessagingStoreOp =
  | { readonly op: 'transcript-ingest'; readonly batch: TranscriptBatchInput }
  | { readonly op: 'provider-session-upsert'; readonly session: ProviderSession }
  | { readonly op: 'send-journal-mutation'; readonly journals: readonly SendJournal[] }
  | { readonly op: 'pending-delivery-mutation'; readonly deliveries: readonly PendingDelivery[] }
  | { readonly op: 'conversation-view-mutation'; readonly mutation: ConversationViewMutation }
  | { readonly op: 'projection-rebuild'; readonly result: ProjectionRebuildResult };

/** The mutation lane one op belongs to; each lane replays in its own sequence order. */
export type MutationLane = 'transcript' | 'send' | 'delivery' | 'conversation' | 'projection';

/** The lane each store op mutates — transcript ingest and session upserts share one lane. */
export const laneOf: Record<MessagingStoreOp['op'], MutationLane> = {
  'transcript-ingest': 'transcript',
  'provider-session-upsert': 'transcript',
  'send-journal-mutation': 'send',
  'pending-delivery-mutation': 'delivery',
  'conversation-view-mutation': 'conversation',
  'projection-rebuild': 'projection',
};

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
  readonly conversationSequence?: number;
  readonly projectionSequence?: number;
  readonly operationKey: string;
  readonly payloadDigest: string;
  readonly storeOp: MessagingStoreOp;
}

/** Untrusted replay input is a plain string-keyed object, not an array or null. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KNOWN_OPS: readonly unknown[] = [
  'transcript-ingest',
  'provider-session-upsert',
  'send-journal-mutation',
  'pending-delivery-mutation',
  'conversation-view-mutation',
  'projection-rebuild',
];

/**
 * Rejects unknown historical payloads without inventing replay meaning. The
 * envelope's own invariants are checked field by field; the one `as` owns the
 * step from "known op envelope" to the full record shape, the boundary parse
 * this module exists to own.
 */
export function messagingStoreRecord(value: unknown): MessagingStoreRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value['kind'] !== 'messagingStoreOp'
    || typeof value['operationKey'] !== 'string'
    || typeof value['payloadDigest'] !== 'string'
    || !isRecord(value['storeOp'])
    || !KNOWN_OPS.includes(value['storeOp']['op'])) return undefined;
  return value as unknown as MessagingStoreRecord;
}
