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
import type { MessagingStoreOp, MessagingStoreRecord } from './foundation-operations.js';

type MutationLane = 'transcript' | 'send' | 'delivery';

/** Serializes all Foundation appends while preserving per-lane replay order. */
export class FoundationMessagingWriter {
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly handle: ScopedStoreHandle,
    private transcriptSequence: number,
    private sendSequence: number,
    private deliverySequence: number,
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
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persistSerialized(
    operationKey: string,
    storeOp: MessagingStoreOp,
    createdAt: string,
    lane: MutationLane,
  ): Promise<void> {
    const payloadDigest = createHash('sha256').update(canonicalJson(storeOp)).digest('hex');
    const id = mintMessagingStoreOpId(operationKey) as unknown as ObjectId;
    const existing = await getObject<MessagingStoreRecord>(this.handle, 'messagingStoreOp', id);
    if (existing.ok && !isAbsent(existing.value)) {
      if (existing.value.object.payloadDigest !== payloadDigest) {
        throw new Error(`Messaging operation ${operationKey} conflicts`);
      }
      return;
    }
    this.increment(lane, 1);
    const record: MessagingStoreRecord = {
      kind: 'messagingStoreOp', id: id as string, schemaVersion: 1, createdAt,
      permissionLevel: 'private', createdBy: 'overridden-by-foundation', storeSequence: 0,
      operationKey, payloadDigest, storeOp, ...this.sequence(lane),
    };
    const written = await createObject(this.handle, record, deriveClientOpId(`messaging:${operationKey}`));
    if (!written.ok) {
      this.increment(lane, -1);
      throw new Error(`Messaging append failed: ${written.error.code}`);
    }
  }

  private sequence(lane: MutationLane): object {
    if (lane === 'transcript') return { transcriptSequence: this.transcriptSequence };
    if (lane === 'send') return { sendSequence: this.sendSequence };
    return { deliverySequence: this.deliverySequence };
  }

  private increment(lane: MutationLane, amount: number): void {
    if (lane === 'transcript') this.transcriptSequence += amount;
    else if (lane === 'send') this.sendSequence += amount;
    else this.deliverySequence += amount;
  }
}
