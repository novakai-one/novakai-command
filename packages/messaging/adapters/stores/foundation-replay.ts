import { listObjects, type ScopedStoreHandle } from '@novakai/foundation/contract';
import { PendingDeliveryState, type PersistedPendingDeliveryMutation } from './pending-delivery-state.js';
import { SendJournalState, type PersistedSendMutation } from './send-journal-state.js';
import {
  TranscriptState,
  type PersistedProviderSession,
  type PersistedTranscriptBatch,
} from './transcript-state.js';
import { messagingStoreRecord } from './foundation-operations.js';
import {
  ConversationViewState,
  type PersistedConversationMutation,
} from './conversation-view-state.js';
import { ProjectionState, type PersistedProjectionRebuild } from './projection-state.js';

/** Fully replayed semantic state and the next sequence in each mutation lane. */
export interface RestoredFoundationMessagingStore {
  readonly transcripts: TranscriptState;
  readonly sends: SendJournalState;
  readonly deliveries: PendingDeliveryState;
  readonly conversations: ConversationViewState;
  readonly projections: ProjectionState;
  readonly transcriptSequence: number;
  readonly sendSequence: number;
  readonly deliverySequence: number;
  readonly conversationSequence: number;
  readonly projectionSequence: number;
}

/** Replays the one Messaging store into its three private state owners. */
export async function restoreFoundationMessagingStore(
  handle: ScopedStoreHandle,
): Promise<RestoredFoundationMessagingStore> {
  const listed = await listObjects<unknown>(
    handle,
    'messagingStoreOp',
    undefined,
    { limit: 1_000_000 },
  );
  if (!listed.ok) throw new Error(`Messaging replay failed: ${listed.error.code}`);
  const batches: PersistedTranscriptBatch[] = [];
  const sessions: PersistedProviderSession[] = [];
  const sends: PersistedSendMutation[] = [];
  const deliveries: PersistedPendingDeliveryMutation[] = [];
  const conversations: PersistedConversationMutation[] = [];
  const projections: PersistedProjectionRebuild[] = [];
  let transcriptSequence = 0;
  let sendSequence = 0;
  let deliverySequence = 0;
  let conversationSequence = 0;
  let projectionSequence = 0;
  for (const item of listed.value.items) {
    const record = messagingStoreRecord(item.object);
    if (record === undefined) continue;
    if (record.storeOp.op === 'transcript-ingest') {
      const sequence = record.transcriptSequence ?? 0;
      transcriptSequence = Math.max(transcriptSequence, sequence);
      batches.push({ sequence, input: record.storeOp.batch });
    } else if (record.storeOp.op === 'provider-session-upsert') {
      const sequence = record.transcriptSequence ?? 0;
      transcriptSequence = Math.max(transcriptSequence, sequence);
      sessions.push({ sequence, session: record.storeOp.session });
    } else if (record.storeOp.op === 'send-journal-mutation') {
      const sequence = record.sendSequence ?? 0;
      sendSequence = Math.max(sendSequence, sequence);
      sends.push({ sequence, journals: record.storeOp.journals });
    } else if (record.storeOp.op === 'pending-delivery-mutation') {
      const sequence = record.deliverySequence ?? 0;
      deliverySequence = Math.max(deliverySequence, sequence);
      deliveries.push({ sequence, deliveries: record.storeOp.deliveries });
    } else if (record.storeOp.op === 'conversation-view-mutation') {
      const sequence = record.conversationSequence ?? 0;
      conversationSequence = Math.max(conversationSequence, sequence);
      conversations.push({ sequence, mutation: record.storeOp.mutation });
    } else {
      const sequence = record.projectionSequence ?? 0;
      projectionSequence = Math.max(projectionSequence, sequence);
      projections.push({ sequence, result: record.storeOp.result });
    }
  }
  const transcripts = new TranscriptState();
  transcripts.restoreSessions(sessions);
  transcripts.restore(batches);
  const sendState = new SendJournalState();
  sendState.restore(sends);
  const deliveryState = new PendingDeliveryState();
  deliveryState.restore(deliveries);
  const conversationState = new ConversationViewState();
  conversationState.restore(conversations);
  const projectionState = new ProjectionState();
  projectionState.restore(projections);
  return {
    transcripts,
    sends: sendState,
    deliveries: deliveryState,
    conversations: conversationState,
    projections: projectionState,
    transcriptSequence,
    sendSequence,
    deliverySequence,
    conversationSequence,
    projectionSequence,
  };
}
