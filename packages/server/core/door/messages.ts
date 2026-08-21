// packages/server/core/door/messages.ts — the agent-side door verbs.
//
// A terminal agent (nvk-msg) sends and reads AS ITSELF: the bearer resolves to
// a configured principal, every write goes through that person's own messaging
// holder (red gate 5 — the door never touches the store), and an agent→Chris
// send lands in the SAME conversation map the Bench renders, broadcast live.
import { randomUUID } from 'node:crypto';
import type { ServerRuntime, Conversation } from '../methods.js';
import { summarize, persistView } from '../methods.js';

const now = (): string => new Date().toISOString();

export interface DoorPrincipal {
  personId: string;
}

/** Bearer → configured principal. Refusal is null — never a weaker identity. */
export function principalForBearer(runtime: ServerRuntime, bearer: string): DoorPrincipal | null {
  const principal = runtime.configStore.current().principals.find((p) => p.token === bearer);
  return principal ? { personId: principal.personId } : null;
}

export interface AddressBookEntry {
  personId: string;
  name: string;
  provider?: string;
  status?: string;
}

export interface AddressBook {
  agents: AddressBookEntry[];
  humans: AddressBookEntry[];
}

/** Every named, reachable person: bound agents plus the human. */
export async function addressBook(runtime: ServerRuntime): Promise<AddressBook> {
  const listed = await runtime.agents.listAgents() as
    { ok: boolean; value?: { items: Array<{ id: string; displayName: string; provider: string; status: string }> } };
  const bindings = runtime.configStore.current().bindings;
  const agents: AddressBookEntry[] = [];
  for (const binding of bindings) {
    const agent = listed.ok ? listed.value?.items.find((a) => a.id === binding.agentId) : undefined;
    if (!agent || agent.status === 'archived') continue;
    agents.push({ personId: binding.personId, name: agent.displayName, provider: agent.provider, status: agent.status });
  }
  return { agents, humans: [{ personId: runtime.human.personId, name: 'chris' }] };
}

/** Display name (or 'chris', or a raw person id) → personId, or null. */
export async function resolvePersonByName(runtime: ServerRuntime, name: string): Promise<string | null> {
  if (name === 'chris' || name === runtime.human.personId) return runtime.human.personId;
  const book = await addressBook(runtime);
  const hit = book.agents.find((a) => a.name.toLowerCase() === name.toLowerCase() || a.personId === name);
  return hit?.personId ?? null;
}

export interface AgentSendInput {
  to: string;
  body: string;
  interrupt?: boolean;
  clientMessageId?: string;
}

export type AgentSendResult =
  | { ok: true; messageId: string; urgentDowngraded?: boolean }
  | { ok: false; status: number; error: string };

export async function agentSend(
  runtime: ServerRuntime, caller: DoorPrincipal, input: AgentSendInput,
): Promise<AgentSendResult> {
  const targetId = await resolvePersonByName(runtime, input.to);
  if (!targetId) return { ok: false, status: 404, error: `unknown recipient "${input.to}" — try 'nvk-msg names'` };
  const holder = await runtime.holderForPerson(caller.personId);
  if (!holder) return { ok: false, status: 401, error: `no messaging principal for ${caller.personId}` };
  const clientMessageId = input.clientMessageId ?? `cmsg_${randomUUID()}`;
  const sent = await holder.call((s) => (s as { sendMessage(i: object): Promise<unknown> }).sendMessage({
    address: `person:${targetId}`,
    body: { text: input.body },
    priority: input.interrupt ? 'urgent' : 'normal',
    clientMessageId,
  })) as {
    kind: string;
    value?: { messageId: string; threadId: string; urgentDowngraded?: boolean };
    error?: { name?: string; message?: string };
  };
  if (sent.kind !== 'ok' || !sent.value) {
    return { ok: false, status: 400, error: `${sent.error?.name ?? 'SendRefused'}: ${sent.error?.message ?? 'unknown'}` };
  }
  // An agent→Chris send must be VISIBLE where Chris looks: land it in the
  // caller's Bench conversation (created on first contact), broadcast live.
  if (targetId === runtime.human.personId) {
    const conversation = await conversationForAgentPerson(runtime, caller.personId, sent.value.threadId);
    conversation.lastActivityAt = now();
    runtime.broadcast('message', {
      id: sent.value.messageId,
      conversationId: conversation.id,
      senderId: caller.personId,
      text: input.body,
      createdAt: now(),
    });
    runtime.broadcast('conversation', summarize(conversation));
  }
  return {
    ok: true,
    messageId: sent.value.messageId,
    ...(sent.value.urgentDowngraded ? { urgentDowngraded: true } : {}),
  };
}

/** The Bench conversation behind an agent person — found, or created durable. */
async function conversationForAgentPerson(
  runtime: ServerRuntime, personId: string, threadId: string,
): Promise<Conversation> {
  const existing = [...runtime.conversations.values()].find((c) =>
    !c.archived && (c.personId === personId || c.address === `person:${personId}` || c.threadId === threadId));
  if (existing) {
    if (!existing.threadId) {
      existing.threadId = threadId;
      await persistView(runtime, existing, runtime.mintOpId());
    }
    return existing;
  }
  const book = await addressBook(runtime);
  const entry = book.agents.find((a) => a.personId === personId);
  const binding = runtime.configStore.current().bindings.find((b) => b.personId === personId);
  const conversation: Conversation = {
    id: `conv_${randomUUID().slice(0, 8)}`,
    address: `person:${personId}`,
    threadId,
    title: entry?.name ?? personId,
    kind: 'agent',
    pinned: false,
    archived: false,
    lastActivityAt: now(),
    personId,
    ...(binding ? { agentId: binding.agentId } : {}),
  };
  runtime.conversations.set(conversation.id, conversation);
  await persistView(runtime, conversation, runtime.mintOpId());
  return conversation;
}

export interface DoorMessage {
  id: string;
  senderId: string;
  createdAt: string;
  priority: string;
  body: { text: string };
}

export type AgentMessagesResult =
  | { ok: true; messages: DoorMessage[] }
  | { ok: false; status: number; error: string };

/** The caller's direct history with one named person (nvk-msg read). */
export async function agentMessages(
  runtime: ServerRuntime, caller: DoorPrincipal, withName: string,
): Promise<AgentMessagesResult> {
  const targetId = await resolvePersonByName(runtime, withName);
  if (!targetId) return { ok: false, status: 404, error: `unknown person "${withName}"` };
  const holder = await runtime.holderForPerson(caller.personId);
  if (!holder) return { ok: false, status: 401, error: `no messaging principal for ${caller.personId}` };
  const threads = await holder.call((s) =>
    (s as { listThreadsForPerson(i: object): Promise<unknown> }).listThreadsForPerson({})) as
    { kind: string; value?: { threads: Array<{ id: string; direct?: { pair: string[] } }> } };
  if (threads.kind !== 'ok' || !threads.value) return { ok: true, messages: [] };
  const thread = threads.value.threads.find((t) => t.direct?.pair.includes(targetId));
  if (!thread) return { ok: true, messages: [] };
  const page = await holder.call((s) =>
    (s as { getMessages(i: object): Promise<unknown> }).getMessages({ threadId: thread.id, limit: 200 })) as
    { kind: string; value?: { messages: Array<{
      id: string; senderId: string; createdAt: string; priority: string; body: { text: string };
    }> } };
  if (page.kind !== 'ok' || !page.value) return { ok: true, messages: [] };
  return {
    ok: true,
    messages: page.value.messages.map((m) => ({
      id: m.id, senderId: m.senderId, createdAt: m.createdAt, priority: m.priority, body: { text: m.body.text },
    })),
  };
}
