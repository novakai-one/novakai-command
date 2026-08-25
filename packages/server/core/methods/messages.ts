/** Conversation reads and sends; Agent content is transcript-first. */
import { randomUUID } from 'node:crypto';
import type { MethodTable } from '../../contract/protocol.js';
import type { Conversation, ServerRuntime } from './runtime.js';
import { now, persistView } from './runtime.js';

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

async function agentMessages(runtime: ServerRuntime, conversation: Conversation) {
  const [sessions, sends] = await Promise.all([
    runtime.transcript.runtime.listProviderSessions(),
    runtime.transcript.runtime.listSendJournals(),
  ]);
  if (sessions.kind !== 'ok' || sends.kind !== 'ok') return [];
  const providerSessions = sessions.value.filter((session) =>
    session.agentId === conversation.agentId);
  const lines = (await Promise.all(providerSessions.map(async (session) => {
    const result = await runtime.transcript.runtime.listTranscriptLines({ sessionId: session.id });
    return result.kind === 'ok'
      ? result.value.map((line) => ({ line, sessionCreatedAt: session.createdAt }))
      : [];
  }))).flat().filter(({ line }) => line.role === 'user' || line.role === 'assistant');
  const clientOpByLine = new Map(sends.value.flatMap((journal) =>
    journal.attempts.flatMap((attempt) => attempt.confirmedLineId === undefined
      ? [] : [[attempt.confirmedLineId, journal.clientOpId] as const])));
  return lines
    .sort((left, right) => {
      return left.sessionCreatedAt.localeCompare(right.sessionCreatedAt)
        || left.line.sourcePosition.sourceEpoch - right.line.sourcePosition.sourceEpoch
        || left.line.sourcePosition.offset - right.line.sourcePosition.offset;
    })
    .map(({ line }) => ({
      id: line.id,
      conversationId: conversation.id,
      senderId: line.role === 'user' ? 'me' : conversation.personId ?? conversation.agentId,
      text: line.text ?? '',
      createdAt: line.providerOccurredAt ?? line.createdAt,
      ...(clientOpByLine.has(line.id) ? { clientOpId: clientOpByLine.get(line.id) } : {}),
    }));
}

async function legacyMessages(runtime: ServerRuntime, conversation: Conversation) {
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
    conversationId: conversation.id,
    senderId: message.senderId === runtime.human.personId ? 'me' : message.senderId,
    text: message.body.text,
    createdAt: message.createdAt,
    clientOpId: message.clientMessageId,
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

async function sendLegacyMessage(
  runtime: ServerRuntime,
  conversation: Conversation,
  input: { text: string; clientOpId?: string },
) {
  const address = conversation.threadId ? `thread:${conversation.threadId}` : conversation.address;
  const clientMessageId = input.clientOpId ?? `cmsg_${randomUUID()}`;
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
    return { ok: false as const, error: `${result.error?.name}: ${result.error?.message}` };
  }
  const learnedThread = !conversation.threadId;
  if (learnedThread) conversation.threadId = result.value.threadId;
  conversation.lastActivityAt = now();
  if (learnedThread) await persistView(runtime, conversation, runtime.mintOpId());
  const message = {
    id: result.value.messageId,
    conversationId: conversation.id,
    senderId: 'me',
    text: input.text,
    createdAt: now(),
    clientOpId: clientMessageId,
    context: runtime.focus,
  };
  runtime.broadcast('message', message);
  return { ok: true as const, message };
}

/** Build conversation reads and sends with Agent content routed transcript-first. */
export function buildMessageMethods(runtime: ServerRuntime): MethodTable {
  return {
    async getMessages(params: never) {
      const input = params as { conversationId: string };
      const conversation = runtime.conversations.get(input.conversationId);
      if (!conversation) return [];
      return conversation.agentId && conversation.provider !== 'mock'
        ? agentMessages(runtime, conversation)
        : legacyMessages(runtime, conversation);
    },

    async sendMessage(params: never) {
      const input = params as { conversationId: string; text: string; clientOpId?: string };
      const conversation = runtime.conversations.get(input.conversationId);
      if (!conversation) return { ok: false, error: 'unknown conversation' };
      if (conversation.unavailable) {
        return { ok: false, error: { ...conversation.unavailable, conversationId: conversation.id } };
      }
      return conversation.agentId && conversation.provider !== 'mock'
        ? sendAgentMessage(runtime, conversation, input)
        : sendLegacyMessage(runtime, conversation, input);
    },
  };
}
