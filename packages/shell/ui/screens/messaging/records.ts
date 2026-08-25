/** Pure Shell-record to Messaging-graph projection helpers. */

import type { AgentDefView, ChatMessage, ConversationSummary } from '../../../contract/index.js';
import { PresenceTracker } from '../../../contract/index.js';
import type { ObjectRecord } from '../../messages-designs/contract';

export const SELF_ID = 'me';
export const SELF_TITLE = 'Chris';

export function threadRecord(conversation: ConversationSummary): ObjectRecord {
  return {
    id: conversation.id,
    kind: 'thread',
    title: conversation.title,
    createdAt: conversation.lastActivityAt,
    fields: {
      archived: conversation.archived,
      pinned: conversation.pinned,
      kind: conversation.kind,
      ...(conversation.agentId ? { agentId: conversation.agentId } : {}),
    },
    refs: conversation.agentId ? [{ kind: 'agent', value: conversation.agentId }] : [],
  };
}

export function messageRecord(message: ChatMessage, conversationAgentId?: string): ObjectRecord {
  const senderId = message.senderId !== SELF_ID && conversationAgentId
    ? conversationAgentId
    : message.senderId;
  return {
    id: message.id,
    kind: 'message',
    title: message.text,
    createdAt: message.createdAt,
    fields: {
      threadId: message.conversationId,
      senderId,
      body: message.text,
      createdAt: message.createdAt,
      ...(message.pending ? { pending: true } : {}),
      ...(message.failed ? { failed: message.failed } : {}),
      ...(message.clientOpId ? { clientOpId: message.clientOpId } : {}),
    },
    refs: [],
  };
}

export function agentRecord(agent: AgentDefView, tracker: PresenceTracker): ObjectRecord {
  const presence = tracker.get(agent.id);
  return {
    id: agent.id,
    kind: 'agent',
    title: agent.displayName,
    createdAt: '',
    fields: {
      provider: agent.provider,
      model: agent.model,
      status: presence.state,
      composing: presence.state === 'active',
    },
    refs: [],
  };
}

export function placeholderAgent(id: string, tracker: PresenceTracker): ObjectRecord {
  const presence = tracker.get(id);
  return {
    id,
    kind: 'agent',
    title: id,
    createdAt: '',
    fields: { status: presence.state, composing: presence.state === 'active' },
    refs: [],
  };
}
