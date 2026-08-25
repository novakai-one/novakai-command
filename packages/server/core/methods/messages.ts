/** Existing conversation message reads and sends. */

import { randomUUID } from 'node:crypto';
import type { MethodTable } from '../../contract/protocol.js';
import type { Conversation, ServerRuntime } from './runtime.js';
import { contextLine, now, persistView } from './runtime.js';

async function threadFor(runtime: ServerRuntime, conversation: Conversation): Promise<string | null> {
  if (conversation.threadId) return conversation.threadId;
  const result = await runtime.human.holder.call((session) => (
    session as { listThreadsForPerson(input: object): Promise<unknown> }
  ).listThreadsForPerson({})) as {
    kind: string;
    value?: { threads: Array<{ id: string; direct?: { pair: string[] } }> };
  };
  if (result.kind !== 'ok' || !result.value) return null;
  const person = conversation.address.startsWith('person:')
    ? conversation.address.slice('person:'.length)
    : null;
  const thread = person
    ? result.value.threads.find((candidate) => candidate.direct?.pair.includes(person))
    : undefined;
  if (!thread) return null;
  conversation.threadId = thread.id;
  return thread.id;
}

export function buildMessageMethods(runtime: ServerRuntime): MethodTable {
  return {
    async getMessages(params: never) {
      const input = params as { conversationId: string };
      const conversation = runtime.conversations.get(input.conversationId);
      if (!conversation) return [];
      const threadId = await threadFor(runtime, conversation);
      if (!threadId) return [];
      const result = await runtime.human.holder.call((session) => (
        session as { getMessages(value: object): Promise<unknown> }
      ).getMessages({ threadId, limit: 200 })) as {
        kind: string;
        value?: { messages: Array<{
          id: string;
          senderId: string;
          body: { text: string };
          createdAt: string;
          clientMessageId: string;
        }> };
      };
      if (result.kind !== 'ok' || !result.value) return [];
      return result.value.messages.map((message) => ({
        id: message.id,
        conversationId: input.conversationId,
        senderId: message.senderId === runtime.human.personId ? 'me' : message.senderId,
        text: message.body.text,
        createdAt: message.createdAt,
        clientOpId: message.clientMessageId,
      }));
    },

    async sendMessage(params: never) {
      const input = params as { conversationId: string; text: string; clientOpId?: string };
      const conversation = runtime.conversations.get(input.conversationId);
      if (!conversation) return { ok: false, error: 'unknown conversation' };
      if (conversation.unavailable) {
        return {
          ok: false,
          error: { ...conversation.unavailable, conversationId: conversation.id },
        };
      }
      const address = conversation.threadId ? `thread:${conversation.threadId}` : conversation.address;
      const clientMessageId = input.clientOpId ?? `cmsg_${randomUUID()}`;
      if (conversation.sessionId) {
        const marked = await runtime.sessions.markSending(
          conversation.sessionId,
          { clientOpId: clientMessageId },
        );
        if (!marked.ok) return { ok: false, error: marked.error };
      }
      const result = await runtime.human.holder.call((session) => (
        session as { sendMessage(value: object): Promise<unknown> }
      ).sendMessage({
        address,
        body: { text: input.text },
        priority: 'normal',
        clientMessageId,
      })) as {
        kind: string;
        value?: { threadId: string; messageId: string };
        error?: { name: string; message: string };
      };
      if (result.kind !== 'ok' || !result.value) {
        if (conversation.sessionId) {
          const closed = await runtime.sessions.markFailed(conversation.sessionId, clientMessageId);
          if (!closed.ok) return { ok: false, error: closed.error };
        }
        return { ok: false, error: `${result.error?.name}: ${result.error?.message}` };
      }
      const learnedThread = !conversation.threadId;
      if (learnedThread) conversation.threadId = result.value.threadId;
      conversation.lastActivityAt = now();
      if (learnedThread) await persistView(runtime, conversation, runtime.mintOpId());

      const message = {
        id: result.value.messageId,
        conversationId: input.conversationId,
        senderId: 'me',
        text: input.text,
        createdAt: now(),
        clientOpId: clientMessageId,
        context: runtime.focus,
      };
      runtime.broadcast('message', message);

      if (conversation.sessionId) {
        await runtime.sessions.clearInterruption(conversation.sessionId);
        const forwarded = await runtime.agents.sendToSession(
          conversation.sessionId as never,
          `${contextLine(runtime.focus)}\n${input.text}`,
        );
        if (!forwarded) {
          const closed = await runtime.sessions.markFailed(conversation.sessionId, clientMessageId);
          if (!closed.ok) return { ok: false, error: closed.error };
          runtime.broadcast('message', {
            id: `note_${randomUUID().slice(0, 8)}`,
            conversationId: input.conversationId,
            senderId: conversation.personId ?? 'system',
            text: '⚠️ session is no longer running',
            createdAt: now(),
          });
          return {
            ok: false,
            error: {
              code: 'ProviderSendFailed',
              sessionId: conversation.sessionId,
              clientOpId: clientMessageId,
            },
          };
        }
      }
      return { ok: true, message };
    },
  };
}
