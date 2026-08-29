import { listObjects, type ScopedStoreHandle } from '@novakai/foundation/contract';
import { MessagingError } from '../../contract/types.js';
import { PendingDeliveryState, type PersistedPendingDeliveryMutation } from './pending-delivery-state.js';
import { SendJournalState, type PersistedSendMutation } from './send-journal-state.js';
import {
  TranscriptState,
  type PersistedProviderSession,
  type PersistedTranscriptBatch,
} from './transcript-state.js';
import {
  laneOf,
  laneSequenceField,
  messagingStoreRecord,
  type MessagingStoreRecord,
  type MutationLane,
} from './foundation-operations.js';
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

/** Every lane's replay envelopes plus the highest sequence seen per lane. */
interface ReplayAccumulator {
  readonly batches: PersistedTranscriptBatch[];
  readonly sessions: PersistedProviderSession[];
  readonly sends: PersistedSendMutation[];
  readonly deliveries: PersistedPendingDeliveryMutation[];
  readonly conversations: PersistedConversationMutation[];
  readonly projections: PersistedProjectionRebuild[];
  readonly sequences: Record<MutationLane, number>;
}

const emptyAccumulator = (): ReplayAccumulator => ({
  batches: [],
  sessions: [],
  sends: [],
  deliveries: [],
  conversations: [],
  projections: [],
  sequences: { transcript: 0, send: 0, delivery: 0, conversation: 0, projection: 0 },
});

/** The lane sequence a record carries, defaulting to zero for records older than sequencing. */
const sequenceOf = (record: MessagingStoreRecord, lane: MutationLane): number =>
  record[laneSequenceField[lane]] ?? 0;

/** Folds one record into its lane's envelope list and high-water sequence. */
const foldRecord = (replay: ReplayAccumulator, record: MessagingStoreRecord): void => {
  const lane = laneOf[record.storeOp.op];
  const sequence = sequenceOf(record, lane);
  replay.sequences[lane] = Math.max(replay.sequences[lane], sequence);
  switch (record.storeOp.op) {
    case 'transcript-ingest':
      replay.batches.push({ sequence, input: record.storeOp.batch });
      return;
    case 'provider-session-upsert':
      replay.sessions.push({ sequence, session: record.storeOp.session });
      return;
    case 'send-journal-mutation':
      replay.sends.push({ sequence, journals: record.storeOp.journals });
      return;
    case 'pending-delivery-mutation':
      replay.deliveries.push({ sequence, deliveries: record.storeOp.deliveries });
      return;
    case 'conversation-view-mutation':
      replay.conversations.push({ sequence, mutation: record.storeOp.mutation });
      return;
    case 'projection-rebuild':
      replay.projections.push({ sequence, result: record.storeOp.result });
      return;
  }
};

/** Folds every parseable record into the accumulator; unknown payloads are skipped. */
const foldAll = (items: readonly { object: unknown }[]): ReplayAccumulator => {
  const replay = emptyAccumulator();
  for (const item of items) {
    const record = messagingStoreRecord(item.object);
    if (record === undefined) continue;
    foldRecord(replay, record);
  }
  return replay;
};

/** Replays the one Messaging store into its private state owners, one lane each. */
export async function restoreFoundationMessagingStore(
  handle: ScopedStoreHandle,
): Promise<RestoredFoundationMessagingStore> {
  const listed = await listObjects<unknown>(
    handle,
    'messagingStoreOp',
    undefined,
    { limit: 1_000_000 },
  );
  if (!listed.ok) {
    throw new MessagingError('DependencyUnavailable', {
      message: `Messaging replay failed: ${listed.error.code}`,
      retryable: true,
      fields: { dependency: 'foundation-store', code: listed.error.code },
    });
  }
  const replay = foldAll(listed.value.items);
  const transcripts = new TranscriptState();
  transcripts.restoreSessions(replay.sessions);
  transcripts.restore(replay.batches);
  const sends = new SendJournalState();
  sends.restore(replay.sends);
  const deliveries = new PendingDeliveryState();
  deliveries.restore(replay.deliveries);
  const conversations = new ConversationViewState();
  conversations.restore(replay.conversations);
  const projections = new ProjectionState();
  projections.restore(replay.projections);
  return {
    transcripts,
    sends,
    deliveries,
    conversations,
    projections,
    transcriptSequence: replay.sequences.transcript,
    sendSequence: replay.sequences.send,
    deliverySequence: replay.sequences.delivery,
    conversationSequence: replay.sequences.conversation,
    projectionSequence: replay.sequences.projection,
  };
}
