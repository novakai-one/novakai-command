import type { Edge, Node } from '@xyflow/react';
import { relationsFor } from '../../record-content';
import { KIND_LABEL, RELATION_LABEL, type ObjectRecord } from '../../contract';
import { field, type ObjectGraph } from '../../graph';
import type { WorldPoint } from '../../../canvas/WorldCanvas';
import type { MessagesDesignData } from '../../contract';
import {
  BENCH_CARD_SIZE,
  BENCH_FRAME_SIZE,
  BENCH_THREAD_SIZE,
  conversationPoint,
  placementMapOf,
  type BenchPlacement,
} from './bench-layout';
import { projectInspectionTrails } from './bench-inspection-projection';
import type {
  BenchConversation,
  BenchDecisionRequest,
  BenchMessage,
  BenchMissionTone,
  BenchModel,
  BenchNodeActions,
  BenchObjectRelation,
  BenchParticipant,
  BenchState,
  ConversationNodeData,
  InspectionWireData,
  MessageInspectorNodeData,
  RelatedObjectNodeData,
  ConversationFrameNodeData,
  DraftConversationNodeData,
} from './bench-model';

const RECENT_CONVERSATION_LIMIT = 10;
const MISSION_TONES: readonly BenchMissionTone[] = ['slate', 'oxide', 'moss', 'violet'];

/** Typed React Flow node union produced only at the projection seam. */
export type BenchConversationCanvasNode = Node<ConversationNodeData, 'bench-conversation'>;

/** Typed message-inspector node at the projection seam. */
export type BenchMessageInspectorCanvasNode = Node<MessageInspectorNodeData, 'bench-message-inspector'>;

/** Typed related-object node at the projection seam. */
export type BenchRelatedObjectCanvasNode = Node<RelatedObjectNodeData, 'bench-related-object'>;

/** Typed semantic frame node at the projection seam. */
export type BenchConversationFrameCanvasNode = Node<ConversationFrameNodeData, 'bench-conversation-frame'>;

/** Typed pending-draft node at the projection seam. */
export type BenchDraftConversationCanvasNode = Node<DraftConversationNodeData, 'bench-draft-conversation'>;

/** Union of every node The Bench supplies to the shared canvas. */
export type BenchCanvasNode =
  | BenchConversationCanvasNode
  | BenchMessageInspectorCanvasNode
  | BenchRelatedObjectCanvasNode
  | BenchConversationFrameCanvasNode
  | BenchDraftConversationCanvasNode;

/** Typed React Flow edge produced only at the projection seam. */
export type BenchCanvasEdge = Edge<InspectionWireData, 'bench-inspection'>;

/** Complete read-only canvas projection consumed by TheBench. */
export type BenchCanvasProjection = {
  readonly nodes: readonly BenchCanvasNode[];
  readonly edges: readonly BenchCanvasEdge[];
};

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function missionToneFor(id: string): BenchMissionTone {
  const value = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return MISSION_TONES[value % MISSION_TONES.length];
}

function participantFor(record: ObjectRecord): BenchParticipant {
  return {
    record,
    initials: initialsFor(record.title) || 'A',
    status: field(record, 'status'),
  };
}

function relationsForRecord(graph: ObjectGraph, record: ObjectRecord): BenchObjectRelation[] {
  const preferredOrder = relationsFor(record.kind);
  const seen = new Set<string>();
  return graph.related(record.id)
    .filter((entry) => {
      const key = `${entry.relation}:${entry.record.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (
      (preferredOrder.indexOf(left.relation) < 0 ? Number.MAX_SAFE_INTEGER : preferredOrder.indexOf(left.relation))
      - (preferredOrder.indexOf(right.relation) < 0 ? Number.MAX_SAFE_INTEGER : preferredOrder.indexOf(right.relation))
      || left.relation.localeCompare(right.relation)
      || left.record.id.localeCompare(right.record.id)
    ))
    .map((entry) => ({
      relation: entry.relation,
      label: RELATION_LABEL[entry.relation] ?? KIND_LABEL[entry.record.kind],
      record: entry.record,
    }));
}

function messageFor(data: MessagesDesignData, record: ObjectRecord): BenchMessage {
  const senderId = field(record, 'senderId');
  const sender = senderId ? data.graph.get(senderId) ?? null : null;
  return {
    record,
    sender,
    senderName: sender?.title ?? 'Unknown sender',
    body: field(record, 'body') || record.title,
    createdAt: field(record, 'createdAt') || record.createdAt,
    isMine: senderId === data.selfId,
    ...(typeof record.fields.failed === 'string' ? { failed: record.fields.failed } : {}),
    relations: relationsForRecord(data.graph, record),
  };
}

function isConversationBlocked(conversation: {
  participants: readonly BenchParticipant[];
  pendingDecisionRequests: readonly BenchDecisionRequest[];
}): boolean {
  if (conversation.participants.some((participant) => participant.status === 'failed')) return true;
  return conversation.pendingDecisionRequests.length > 0;
}

function decisionRequestsFor(
  data: MessagesDesignData,
  threadId: string,
  messages: readonly BenchMessage[],
): BenchDecisionRequest[] {
  const requests = new Map<string, BenchDecisionRequest>();
  for (const message of messages) {
    for (const relation of message.relations) {
      const request = relation.record;
      if (request.kind !== 'request' || field(request, 'status') !== 'pending' || requests.has(request.id)) {
        continue;
      }
      const agent = data.graph.relatedOfKind(request.id, 'blocks', 'agent')[0];
      const options = Array.isArray(request.fields.options)
        ? request.fields.options.filter((option): option is string => typeof option === 'string')
        : [];
      requests.set(request.id, {
        record: request,
        question: field(request, 'question') || request.title,
        agentName: agent?.title ?? 'Agent',
        options,
        context: {
          threadId,
          rootMessageId: message.record.id,
          requestId: request.id,
          requestRelation: relation.relation,
        },
      });
    }
  }
  return [...requests.values()];
}

function conversationFor(data: MessagesDesignData, thread: ObjectRecord): BenchConversation {
  const participants = data.graph.relatedOfKind(thread.id, 'discusses', 'agent').map(participantFor);
  const mission = data.graph.relatedOfKind(thread.id, 'discusses', 'mission')[0] ?? null;
  const messages = data.graph
    .relatedOfKind(thread.id, 'contains', 'message')
    .map((record) => messageFor(data, record))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const notifications = data.graph.relatedOfKind(thread.id, 'notified', 'notification');
  const composingParticipant = participants.find((participant) => (
    participant.record.fields.composing === true
  ));
  const pendingDecisionRequests = decisionRequestsFor(data, thread.id, messages);

  return {
    thread,
    participants,
    primaryParticipant: participants[0] ?? null,
    mission: mission ? { record: mission, tone: missionToneFor(mission.id) } : null,
    messages,
    previewLines: messages.slice(-2).map((message) => message.body),
    unreadCount: notifications.filter((record) => field(record, 'status') === 'unread').length,
    lastActivityAt: messages.at(-1)?.createdAt ?? thread.createdAt,
    isBlocked: isConversationBlocked({ participants, pendingDecisionRequests }),
    composingAgentName: composingParticipant?.record.title ?? null,
    pendingDecisionRequests,
  };
}

function recentConversations(
  conversations: readonly BenchConversation[],
  initialThreadId?: string,
): BenchConversation[] {
  const sorted = conversations
    .slice()
    .sort((left, right) => (
      right.lastActivityAt.localeCompare(left.lastActivityAt)
      || left.thread.id.localeCompare(right.thread.id)
    ));
  const recent = sorted.slice(0, RECENT_CONVERSATION_LIMIT);
  const routed = initialThreadId
    ? conversations.find((conversation) => conversation.thread.id === initialThreadId)
    : undefined;
  if (!routed || recent.some((conversation) => conversation.thread.id === routed.thread.id)) return recent;
  return [...recent.slice(0, RECENT_CONVERSATION_LIMIT - 1), routed];
}

/** Builds the immutable Bench model from the host's normalized relational graph. */
export function buildBenchModel(data: MessagesDesignData): BenchModel {
  const conversations = recentConversations(
    data.threads
      .filter((thread) => thread.fields.archived !== true)
      .map((thread) => conversationFor(data, thread)),
    data.initialThreadId,
  );
  const relationsByRecordId = new Map(data.graph.all.map((record) => (
    [record.id, relationsForRecord(data.graph, record)] as const
  )));
  const decisionRequestsById = new Map(conversations.flatMap((conversation) => (
    conversation.pendingDecisionRequests.map((request) => [request.record.id, request] as const)
  )));
  return {
    conversations,
    conversationsById: new Map(conversations.map((conversation) => [conversation.thread.id, conversation])),
    messagesById: new Map(conversations.flatMap((conversation) => (
      conversation.messages.map((message) => [message.record.id, message] as const)
    ))),
    recordsById: new Map(data.graph.all.map((record) => [record.id, record])),
    relationsByRecordId,
    decisionRequestsById,
    missions: data.graph.byKind('mission'),
    liveAgents: data.liveAgents,
  };
}

function frameForConversation(state: BenchState, threadId: string): string | undefined {
  return state.session.frames.find((frame) => frame.conversationIds.includes(threadId))?.id;
}

function frameNodes(
  state: BenchState,
  placements: readonly BenchPlacement[],
  frameSeedPoints: ReadonlyMap<string, WorldPoint>,
  actions: BenchNodeActions,
): BenchConversationFrameCanvasNode[] {
  const placementMap = placementMapOf(placements);
  return state.session.frames.map((frame, index) => ({
    id: frame.id,
    type: 'bench-conversation-frame',
    position: placementMap.get(frame.id)?.position
      ?? frameSeedPoints.get(frame.id)
      ?? { x: 48 + index * 96, y: 48 + index * 72 },
    data: {
      kind: 'conversation-frame',
      selectionId: frame.id,
      frame,
      actions,
    },
    style: { width: BENCH_FRAME_SIZE.width, height: BENCH_FRAME_SIZE.height },
    zIndex: 1,
  }));
}

function conversationNodes(
  model: BenchModel,
  state: BenchState,
  placements: readonly BenchPlacement[],
  actions: BenchNodeActions,
): BenchCanvasNode[] {
  const placementMap = placementMapOf(placements);
  return model.conversations.map((conversation, index) => {
    const isOpen = state.session.openThreadIds.includes(conversation.thread.id);
    const size = isOpen ? BENCH_THREAD_SIZE : BENCH_CARD_SIZE;
    const parentId = frameForConversation(state, conversation.thread.id);
    return {
      id: conversation.thread.id,
      type: 'bench-conversation',
      position: conversationPoint(conversation.thread.id, index, placementMap),
      ...(parentId ? { parentId } : {}),
      data: {
        kind: 'conversation',
        selectionId: conversation.thread.id,
        conversation,
        isOpen,
        isFocused: state.session.focusedThreadId === conversation.thread.id,
        tier: state.zoomTier,
        savedScrollTop: state.session.scrollTopByThreadId[conversation.thread.id] ?? 0,
        missions: model.missions,
        actions,
      },
      style: { width: size.width, height: size.height },
      zIndex: isOpen ? 20 : 10,
    };
  });
}

function draftNodes(
  model: BenchModel,
  state: BenchState,
  placements: readonly BenchPlacement[],
  draftPoint: WorldPoint | null,
  acceptDraft: (agent: ObjectRecord) => void,
  cancelDraft: () => void,
): BenchDraftConversationCanvasNode[] {
  const draft = state.session.pendingDraft;
  if (!draft) return [];
  const placement = placementMapOf(placements).get(draft.id);
  return [{
    id: draft.id,
    type: 'bench-draft-conversation',
    position: placement?.position ?? draftPoint ?? { x: 160, y: 160 },
    data: {
      kind: 'draft-conversation',
      selectionId: draft.id,
      draft,
      agents: model.liveAgents,
      accept: acceptDraft,
      cancel: cancelDraft,
    },
    style: { width: BENCH_CARD_SIZE.width, minHeight: 248 },
    zIndex: 80,
  }];
}

/** Purely projects Bench state and neutral placement snapshots into canvas records. */
export function projectBenchCanvas(
  model: BenchModel,
  state: BenchState,
  placements: readonly BenchPlacement[] | null,
  actions: BenchNodeActions,
  options: {
    readonly draftPoint: WorldPoint | null;
    readonly frameSeedPoints: ReadonlyMap<string, WorldPoint>;
    readonly acceptDraft: (agent: ObjectRecord) => void;
    readonly cancelDraft: () => void;
  },
): BenchCanvasProjection {
  const activePlacements = placements ?? [];
  const frames = frameNodes(state, activePlacements, options.frameSeedPoints, actions);
  const conversations = conversationNodes(model, state, activePlacements, actions);
  const drafts = draftNodes(
    model,
    state,
    activePlacements,
    options.draftPoint,
    options.acceptDraft,
    options.cancelDraft,
  );
  const trails = placements === null
    ? { nodes: [], edges: [] }
    : projectInspectionTrails(model, state, placements, actions);
  return { nodes: [...frames, ...conversations, ...drafts, ...trails.nodes], edges: trails.edges };
}
