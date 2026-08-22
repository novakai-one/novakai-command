import type { ObjectId } from '../../contract';
import type {
  BenchConversation,
  BenchObjectRelation,
} from '../model/bench-model';
import type {
  ConversationInstrumentSource,
  ConversationRelationKind,
  ConversationRelationSource,
} from './contract';

const GROUPABLE_KINDS = new Set<ConversationRelationKind>(['project', 'mission', 'task']);

function plainRelations(
  conversation: BenchConversation,
  relationsByRecordId: ReadonlyMap<ObjectId, readonly BenchObjectRelation[]>,
): ConversationRelationSource[] {
  const relations = new Map<string, ConversationRelationSource>();
  for (const relation of relationsByRecordId.get(conversation.thread.id) ?? []) {
    if (!GROUPABLE_KINDS.has(relation.record.kind as ConversationRelationKind)) continue;
    relations.set(relation.record.id, {
      relationId: relation.record.id,
      kind: relation.record.kind as ConversationRelationKind,
      label: relation.record.title,
      relation: relation.relation,
    });
  }
  if (conversation.mission && !relations.has(conversation.mission.record.id)) {
    relations.set(conversation.mission.record.id, {
      relationId: conversation.mission.record.id,
      kind: 'mission',
      label: conversation.mission.record.title,
      relation: 'belongsTo',
    });
  }
  return [...relations.values()];
}

/** Adapts Bench truth without exposing graph, reducer, or canvas implementation. */
export function adaptBenchInstrumentSource(
  conversations: readonly BenchConversation[],
  placedThreadIds: readonly string[],
  relationsByRecordId: ReadonlyMap<ObjectId, readonly BenchObjectRelation[]>,
  removableThreadIds: readonly string[],
): ConversationInstrumentSource[] {
  const placed = new Set(placedThreadIds);
  const removable = new Set(removableThreadIds);
  return conversations.map((conversation) => ({
    threadId: conversation.thread.id,
    title: conversation.thread.title,
    createdAt: conversation.thread.createdAt,
    people: conversation.participants.map((participant) => ({
      personId: participant.record.id,
      label: participant.record.title,
      initials: participant.initials,
      status: participant.status,
    })),
    relations: plainRelations(conversation, relationsByRecordId),
    messages: conversation.messages.map((message) => ({
      messageId: message.record.id,
      body: message.body,
      createdAt: message.createdAt,
    })),
    lastActivityAt: conversation.lastActivityAt,
    unreadCount: conversation.unreadCount,
    blocked: conversation.isBlocked,
    canvasState: placed.has(conversation.thread.id) ? 'placed' : 'available',
    canRemove: removable.has(conversation.thread.id),
  }));
}
