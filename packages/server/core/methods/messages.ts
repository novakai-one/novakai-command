/** Conversation reads and sends; Agent content is transcript-first. */
import { randomUUID } from 'node:crypto';
import type { MethodTable } from '../../contract/protocol.js';
import type { Conversation, ServerRuntime } from './runtime.js';
import { now } from './runtime.js';

const LEGACY_REMOVED = {
  code: 'ConversationUnavailable',
  message:
    'This conversation predates transcript-first messaging and has no Agent. '
    + 'Archive it and start a new conversation.',
} as const;

async function agentMessages(runtime: ServerRuntime, conversation: Conversation) {
  if (!conversation.agentId) return [];
  const result = await runtime.transcript.runtime.listAgentConversationMessages({
    agentId: conversation.agentId,
  });
  if (result.kind !== 'ok') return [];
  return result.value.map((message) => ({
    id: message.id,
    conversationId: conversation.id,
    senderId: message.role === 'user' ? 'me' : conversation.personId ?? conversation.agentId,
    text: message.text,
    createdAt: message.occurredAt,
    ...(message.clientOpId === undefined ? {} : { clientOpId: message.clientOpId }),
  }));
}

async function sendAgentMessage(
  runtime: ServerRuntime,
  conversation: Conversation,
  input: { text: string; clientOpId?: string },
) {
  if (!conversation.agentId) return { ok: false as const, error: 'conversation has no Agent' };
  const clientOpId = input.clientOpId ?? `cmsg_${randomUUID()}`;
  const result = await runtime.transcript.runtime.sendConversationMessage({
    conversationId: conversation.id,
    issuedBy: runtime.human.personId,
    targetAgentId: conversation.agentId,
    text: input.text,
    clientOpId,
    screenContext: { ...runtime.focus },
  });
  if (result.kind !== 'ok') {
    return {
      ok: false as const,
      error: { code: result.error.name, message: result.error.message },
    };
  }
  conversation.lastActivityAt = now();
  const message = {
    id: result.value.sendId,
    conversationId: conversation.id,
    senderId: 'me',
    text: input.text,
    createdAt: now(),
    clientOpId,
    context: runtime.focus,
    pending: result.value.state !== 'confirmed',
    sendState: result.value.state,
  };
  return { ok: true as const, message };
}

function isAgentConversation(conversation: Conversation): boolean {
  return conversation.agentId !== undefined && conversation.provider !== 'mock';
}

/** Build conversation reads and sends with Agent content routed transcript-first. */
export function buildMessageMethods(runtime: ServerRuntime): MethodTable {
  return {
    async getMessages(params: never) {
      const input = params as { conversationId: string };
      const conversation = runtime.conversations.get(input.conversationId);
      if (!conversation) return [];
      return isAgentConversation(conversation) ? agentMessages(runtime, conversation) : [];
    },

    async sendMessage(params: never) {
      const input = params as { conversationId: string; text: string; clientOpId?: string };
      const conversation = runtime.conversations.get(input.conversationId);
      if (!conversation) return { ok: false, error: 'unknown conversation' };
      if (conversation.unavailable) {
        return { ok: false, error: { ...conversation.unavailable, conversationId: conversation.id } };
      }
      if (!isAgentConversation(conversation)) {
        return { ok: false, error: { ...LEGACY_REMOVED, conversationId: conversation.id } };
      }
      return sendAgentMessage(runtime, conversation, input);
    },
  };
}
