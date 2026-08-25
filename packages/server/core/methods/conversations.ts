/** Conversation list, creation and view-state methods. */

import { randomUUID } from 'node:crypto';
import type { MethodTable } from '../../contract/protocol.js';
import { ensureAgent, ensureAgentPerson } from '../door/provision.js';
import type { Conversation, ServerRuntime } from './runtime.js';
import { now, persistView, summarize } from './runtime.js';

export function buildConversationMethods(runtime: ServerRuntime): MethodTable {
  return {
    async listConversations() {
      return [...runtime.conversations.values()].map(summarize);
    },

    async createConversation(params: never) {
      const input = params as {
        title: string;
        kind: Conversation['kind'];
        clientOpId: string;
      };
      const id = `conv_${randomUUID().slice(0, 8)}`;
      let address = `thread:thread_${randomUUID().slice(0, 8)}`;
      let agentId: string | undefined;
      let personId: string | undefined;
      if (input.kind === 'agent') {
        agentId = await ensureAgent(runtime, input.title, 'kimi');
        personId = await ensureAgentPerson(runtime, agentId);
        address = `person:${personId}`;
      }
      const conversation: Conversation = {
        id,
        address,
        title: input.title,
        kind: input.kind,
        pinned: false,
        archived: false,
        lastActivityAt: now(),
        ...(agentId ? { agentId } : {}),
        ...(personId ? { personId } : {}),
      };
      runtime.conversations.set(id, conversation);
      await persistView(runtime, conversation, input.clientOpId);
      const summary = summarize(conversation);
      runtime.broadcast('conversation', summary);
      return summary;
    },

    async pinConversation(params: never) {
      const input = params as { id: string; pinned: boolean; clientOpId: string };
      const conversation = runtime.conversations.get(input.id);
      if (!conversation) return { ok: false, error: 'unknown conversation' };
      conversation.pinned = input.pinned;
      conversation.lastActivityAt = now();
      await persistView(runtime, conversation, input.clientOpId);
      runtime.broadcast('conversation', summarize(conversation));
      return { ok: true };
    },

    async markConversationRead(params: never) {
      const input = params as {
        conversationId: string;
        lastMessageId: string;
        clientOpId: string;
      };
      const conversation = runtime.conversations.get(input.conversationId);
      if (!conversation) return { ok: false, error: 'unknown conversation' };
      if (!input.lastMessageId || !input.clientOpId) {
        return { ok: false, error: 'lastMessageId and clientOpId are required' };
      }
      if (conversation.lastReadMessageId === input.lastMessageId) return { ok: true };
      conversation.lastReadMessageId = input.lastMessageId;
      await persistView(runtime, conversation, input.clientOpId);
      runtime.broadcast('conversation', summarize(conversation));
      return { ok: true };
    },

    async archiveConversation(params: never) {
      const input = params as { id: string; archived: boolean; clientOpId: string };
      const conversation = runtime.conversations.get(input.id);
      if (!conversation) return { ok: false, error: 'unknown conversation' };
      conversation.archived = input.archived;
      conversation.lastActivityAt = now();
      await persistView(runtime, conversation, input.clientOpId);
      runtime.broadcast('conversation', summarize(conversation));
      return { ok: true };
    },
  };
}
