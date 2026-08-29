import { createHash } from 'node:crypto';
import {
  canonicalJson,
  createObject,
  deriveClientOpId,
  getObject,
  isAbsent,
  mintMessagingStoreOpId,
  type ObjectId,
  type ScopedStoreHandle,
} from '@novakai/foundation/contract';
import type { TranscriptBatchInput } from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { ConversationViewMutation } from '../../contract/records/conversation-view.js';
import type { ProjectionRebuildResult } from '../../contract/records/projections.js';
import { MessagingError } from '../../contract/types.js';
import {
  type MessagingStoreOp,
  type MessagingStoreRecord,
  type MutationLane,
} from './foundation-operations.js';

/**
 * Foundation's ObjectId brand is opaque to Messaging; the minted op id crosses
 * at this one seam, the single place the two brands meet.
 */
const storeOpObjectId = (operationKey: string): ObjectId =>
  mintMessagingStoreOpId(operationKey) as unknown as ObjectId;

/** The per-lane sequence field one record carries — each lane stamps exactly its own. */
const sequenceStamp = (lane: MutationLane, value: number): Partial<MessagingStoreRecord> => {
  switch (lane) {
    case 'transcript': return { transcriptSequence: value };
    case 'send': return { sendSequence: value };
    case 'delivery': return { deliverySequence: value };
    case 'conversation': return { conversationSequence: value };
    case 'projection': return { projectionSequence: value };
  }
};

/** Serializes all Foundation appends while preserving per-lane replay order. */
export class FoundationMessagingWriter {
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly handle: ScopedStoreHandle,
    private readonly sequences: Record<MutationLane, number>,
  ) {}

  persistTranscript(input: TranscriptBatchInput): Promise<void> {
    const operationKey = [
      'transcript-ingest', input.checkpoint.sourceId, input.checkpoint.sourceEpoch,
      input.expectedCheckpoint?.offset ?? 0, input.checkpoint.offset,
    ].join(':');
    return this.persist(operationKey, { op: 'transcript-ingest', batch: input },
      input.checkpoint.updatedAt, 'transcript');
  }

  persistSession(session: ProviderSession): Promise<void> {
    return this.persistContent(
      `provider-session:${session.id}`,
      { op: 'provider-session-upsert', session },
      session.createdAt,
      'transcript',
    );
  }

  persistSends(journals: readonly SendJournal[]): Promise<void> {
    return this.persistContent(
      `send-journal:${journals.map((item) => item.id).join(',')}`,
      { op: 'send-journal-mutation', journals },
      journals[0]?.updatedAt ?? new Date().toISOString(),
      'send',
    );
  }

  persistDeliveries(deliveries: readonly PendingDelivery[]): Promise<void> {
    return this.persistContent(
      `pending-delivery:${deliveries.map((item) => item.id).join(',')}`,
      { op: 'pending-delivery-mutation', deliveries },
      deliveries[0]?.updatedAt ?? new Date().toISOString(),
      'delivery',
    );
  }

  persistConversation(mutation: ConversationViewMutation): Promise<void> {
    return this.persistContent(
      `conversation-view:${mutation.clientOpId}`,
      { op: 'conversation-view-mutation', mutation },
      mutation.view.updatedAt,
      'conversation',
    );
  }

  persistProjections(result: ProjectionRebuildResult): Promise<void> {
    return this.persistContent(
      'projection-rebuild',
      { op: 'projection-rebuild', result },
      new Date().toISOString(),
      'projection',
    );
  }

  private persistContent(
    prefix: string,
    storeOp: MessagingStoreOp,
    createdAt: string,
    lane: MutationLane,
  ): Promise<void> {
    const digest = createHash('sha256').update(canonicalJson(storeOp)).digest('hex');
    return this.persist(`${prefix}:${digest}`, storeOp, createdAt, lane);
  }

  private persist(
    operationKey: string,
    storeOp: MessagingStoreOp,
    createdAt: string,
    lane: MutationLane,
  ): Promise<void> {
    const operation = () => this.persistSerialized(operationKey, storeOp, createdAt, lane);
    const chained = this.mutationTail.then(operation, operation);
    this.mutationTail = chained.then(() => undefined, () => undefined);
    return chained;
  }

  private async persistSerialized(
    operationKey: string,
    storeOp: MessagingStoreOp,
    createdAt: string,
    lane: MutationLane,
  ): Promise<void> {
    const payloadDigest = createHash('sha256').update(canonicalJson(storeOp)).digest('hex');
    const id = storeOpObjectId(operationKey);
    if (await this.alreadyPersisted(id, operationKey, payloadDigest)) return;
    this.sequences[lane] += 1;
    const record: MessagingStoreRecord = {
      kind: 'messagingStoreOp', id: String(id), schemaVersion: 1, createdAt,
      permissionLevel: 'private', createdBy: 'overridden-by-foundation', storeSequence: 0,
      operationKey, payloadDigest, storeOp,
      ...sequenceStamp(lane, this.sequences[lane]),
    };
    const written = await createObject(this.handle, record, deriveClientOpId(`messaging:${operationKey}`));
    if (!written.ok) {
      this.sequences[lane] -= 1;
      throw new MessagingError('DependencyUnavailable', {
        message: `Messaging append failed: ${written.error.code}`,
        retryable: true,
        fields: { dependency: 'foundation-store', code: written.error.code },
      });
    }
  }

  /**
   * True when this operation key is already persisted with the same payload;
   * the same key carrying a different payload is a typed conflict.
   */
  private async alreadyPersisted(
    id: ObjectId,
    operationKey: string,
    payloadDigest: string,
  ): Promise<boolean> {
    const existing = await getObject<MessagingStoreRecord>(this.handle, 'messagingStoreOp', id);
    if (!existing.ok || isAbsent(existing.value)) return false;
    if (existing.value.object.payloadDigest === payloadDigest) return true;
    throw new MessagingError('IdempotencyConflict', {
      message: `Messaging operation ${operationKey} conflicts`,
      fields: { operationKey },
    });
  }
}
