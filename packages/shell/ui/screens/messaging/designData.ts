/** Assemble the immutable graph consumed by Messaging designs. */

import type {
  AgentDefView,
  ChatMessage,
  ConversationSummary,
  ShellServices,
} from '../../../contract/index.js';
import { PresenceTracker } from '../../../contract/index.js';
import type { MessagesDesignData, ObjectRecord } from '../../messages-designs/contract';
import { buildGraph } from '../../messages-designs/graph';
import {
  SELF_ID,
  SELF_TITLE,
  agentRecord,
  messageRecord,
  placeholderAgent,
  threadRecord,
} from './records.js';
import { unreadNotificationRecords } from './unread.js';

export interface DesignDataInput {
  conversations: readonly ConversationSummary[];
  messagesByConversation: ReadonlyMap<string, ChatMessage[]>;
  agents: readonly AgentDefView[];
  tracker: PresenceTracker;
  providerAvailability: ShellServices['providerAvailability'];
  selectedId: string | null;
}

export function createDesignData(input: DesignDataInput): MessagesDesignData {
  const threads = input.conversations.map(threadRecord);
  const agentByConversation = new Map(
    input.conversations.map((conversation) => [conversation.id, conversation.agentId]),
  );
  const messages = [...input.messagesByConversation.values()].flat()
    .map((message) => messageRecord(message, agentByConversation.get(message.conversationId)));
  const knownAgentIds = new Set(input.agents.map((agent) => agent.id));
  const referencedAgentIds = new Set(
    input.conversations
      .map((conversation) => conversation.agentId)
      .filter((id): id is string => Boolean(id)),
  );
  const agentRecords = [
    ...input.agents
      .filter((agent) => agent.status !== 'archived')
      .map((agent) => agentRecord(agent, input.tracker)),
    ...[...referencedAgentIds]
      .filter((id) => !knownAgentIds.has(id))
      .map((id) => placeholderAgent(id, input.tracker)),
  ];
  const self: ObjectRecord = {
    id: SELF_ID, kind: 'principal', title: SELF_TITLE, createdAt: '', fields: {}, refs: [],
  };
  const unread = input.conversations.flatMap((conversation) => (
    unreadNotificationRecords(
      conversation,
      input.messagesByConversation.get(conversation.id) ?? [],
    )
  ));
  const graph = buildGraph([self, ...agentRecords, ...threads, ...messages, ...unread]);
  const conversedAgentIds = new Set(
    input.conversations
      .filter((conversation) => !conversation.archived && conversation.agentId)
      .map((conversation) => conversation.agentId),
  );
  const spawnable = input.providerAvailability ?? {};
  const liveAgents: ObjectRecord[] = [
    ...agentRecords.filter((agent) => !conversedAgentIds.has(agent.id)),
    ...(['kimi', 'claude', 'codex', 'mock'] as const)
      .filter((provider) => spawnable[provider])
      .map((provider): ObjectRecord => ({
        id: `new:${provider}`,
        kind: 'agent',
        title: `New ${provider} agent`,
        createdAt: '',
        fields: { provider },
        refs: [],
      })),
  ];
  return {
    graph,
    selfId: SELF_ID,
    threads,
    liveAgents,
    selected: input.selectedId ? graph.get(input.selectedId) ?? null : null,
    attentionSubjectId: null,
  };
}
