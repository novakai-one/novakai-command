// packages/server/core/door/user.ts — the human-side door verbs (Slack bridge).
//
// The bridge acts FOR Chris on his phone: roster, threads, message history, and
// send. A send travels the exact ws sendMessage method the Bench uses — same
// PTY forward, same broadcasts — so a Slack reply and a Bench reply are one
// path (red gate 23).
import type { MethodTable } from '../../contract/protocol.js';
import type { ServerRuntime } from '../methods.js';

export interface RosterEntry {
  agentId: string;
  title: string;
  personId: string | null;
  provider: string;
  status: string;
}

/** Bound + live agents, with their person ids so the bridge can name senders. */
export async function roster(runtime: ServerRuntime): Promise<{ agents: RosterEntry[] }> {
  const listed = await runtime.agents.listAgents() as
    { ok: boolean; value?: { items: Array<{ id: string; displayName: string; provider: string; status: string }> } };
  if (!listed.ok || !listed.value) return { agents: [] };
  const bindings = runtime.configStore.current().bindings;
  return {
    agents: listed.value.items
      .filter((item) => item.status !== 'archived')
      .map((item) => ({
        agentId: item.id,
        title: item.displayName,
        personId: bindings.find((binding) => binding.agentId === item.id)?.personId ?? null,
        provider: item.provider,
        status: item.status,
      })),
  };
}

export interface UserThread {
  id: string;
  threadKind: 'direct' | 'room';
  direct?: { pair: string[] };
  label?: string;
}

export async function userThreads(runtime: ServerRuntime): Promise<{ threads: UserThread[] }> {
  const listed = await runtime.human.holder.call((session) =>
    (session as { listThreadsForPerson(input: object): Promise<unknown> }).listThreadsForPerson({})) as
    { kind: string; value?: { threads: Array<{ id: string; direct?: { pair: string[] }; room?: { label?: string } }> } };
  if (listed.kind !== 'ok' || !listed.value) return { threads: [] };
  return {
    threads: listed.value.threads.map((thread) => ({
      id: thread.id,
      threadKind: thread.direct ? 'direct' as const : 'room' as const,
      ...(thread.direct ? { direct: { pair: thread.direct.pair } } : {}),
      ...(thread.room?.label ? { label: thread.room.label } : {}),
    })),
  };
}

export interface UserMessage {
  id: string;
  threadId: string;
  sequence: number;
  senderId: string;
  createdAt: string;
  body: { text: string };
}

export async function userMessages(
  runtime: ServerRuntime, threadId: string,
): Promise<{ messages: UserMessage[] }> {
  const page = await runtime.human.holder.call((session) =>
    (session as { getMessages(input: object): Promise<unknown> }).getMessages({ threadId, limit: 200 })) as
    { kind: string; value?: { messages: Array<{
      id: string; threadId: string; sequence: number; senderId: string; createdAt: string; body: { text: string };
    }> } };
  if (page.kind !== 'ok' || !page.value) return { messages: [] };
  return {
    messages: page.value.messages.map((message) => ({
      id: message.id, threadId: message.threadId, sequence: message.sequence,
      senderId: message.senderId, createdAt: message.createdAt, body: { text: message.body.text },
    })),
  };
}

export type UserSendResult =
  | { ok: true; messageId?: string }
  | { ok: false; status: number; error: string; roster?: string[] };

/**
 * Chris (via Slack) → a named agent's conversation, through the ws sendMessage
 * method so a live PTY session receives the text exactly as a Bench send.
 */
export async function userSend(
  runtime: ServerRuntime, methods: MethodTable, toName: string, text: string,
): Promise<UserSendResult> {
  const { agents } = await roster(runtime);
  const agent = agents.find((entry) => entry.title.toLowerCase() === toName.toLowerCase());
  const names = agents.map((entry) => entry.title);
  if (!agent) return { ok: false, status: 404, error: `no agent named "${toName}"`, roster: names };
  const conversation = [...runtime.conversations.values()].find((view) =>
    !view.archived && (view.agentId === agent.agentId || (agent.personId !== null && view.personId === agent.personId)));
  if (!conversation) {
    return { ok: false, status: 404, error: `no conversation with "${toName}" — open one in the app first`, roster: names };
  }
  const sent = await (methods.sendMessage as (p: unknown) => Promise<unknown>)({
    conversationId: conversation.id, text,
  }) as { ok: boolean; message?: { id: string }; error?: unknown };
  if (!sent.ok) {
    const reason = typeof sent.error === 'string' ? sent.error : JSON.stringify(sent.error);
    return { ok: false, status: 502, error: reason };
  }
  return { ok: true, ...(sent.message ? { messageId: sent.message.id } : {}) };
}
