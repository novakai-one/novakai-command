/** Provider-session lane attachment and restart restoration. */

import type { Conversation, ServerRuntime } from './runtime.js';
import { now, persistView } from './runtime.js';

export function attachLane(
  runtime: ServerRuntime,
  conversation: Conversation,
  sessionId: string,
  personId: string,
): void {
  const sender = {
    async sendMessage(input: unknown) {
      const holder = await runtime.holderForPerson(personId);
      if (!holder) {
        return {
          kind: 'error',
          error: { name: 'NotAuthenticated', message: `no holder for ${personId}` },
        };
      }
      const result = await holder.call((session) => (
        session as { sendMessage(value: unknown): Promise<unknown> }
      ).sendMessage(input)) as {
        kind: string;
        value?: { threadId: string; messageId: string };
      };
      if (result.kind === 'ok' && result.value) {
        const learnedThread = !conversation.threadId;
        if (learnedThread) conversation.threadId = result.value.threadId;
        conversation.lastActivityAt = now();
        if (learnedThread) await persistView(runtime, conversation, runtime.mintOpId());
        runtime.broadcast('message', {
          id: result.value.messageId,
          conversationId: conversation.id,
          senderId: personId,
          text: (input as { body: { text: string } }).body.text,
          createdAt: now(),
        });
      }
      return result;
    },
  };
  runtime.agents.attachLiveLane({
    sessionId,
    address: `person:${runtime.human.personId}`,
    sender,
  } as never);
}

export async function restoreLiveSessions(runtime: ServerRuntime): Promise<number> {
  const config = runtime.configStore.current();
  const threads = await runtime.human.holder.call((session) => (
    session as { listThreadsForPerson(input: object): Promise<unknown> }
  ).listThreadsForPerson({})) as {
    kind: string;
    value?: { threads: Array<{ id: string; direct?: { pair: string[] } }> };
  };
  const byPerson = new Map<string, string>();
  if (threads.kind === 'ok' && threads.value) {
    for (const thread of threads.value.threads) {
      for (const person of thread.direct?.pair ?? []) byPerson.set(person, thread.id);
    }
  }

  let restored = 0;
  for (const record of await runtime.sessions.resumable()) {
    const binding = config.bindings.find((candidate) => candidate.agentId === record.agentId);
    if (!binding) continue;
    const rebound = runtime.agents.reattachSession({
      sessionId: record.sessionId,
      agentId: record.agentId,
      provider: record.provider,
      providerConversationId: record.providerConversationId,
      model: record.model,
      cwd: record.cwd,
    });
    if (!rebound) continue;
    const threadId = byPerson.get(binding.personId);
    const conversation = [...runtime.conversations.values()]
      .find((candidate) => candidate.threadId === threadId);
    if (!conversation) continue;
    conversation.sessionId = record.sessionId;
    conversation.personId = binding.personId;
    conversation.provider = record.provider;
    conversation.agentId = record.agentId;
    conversation.address = `person:${binding.personId}`;
    attachLane(runtime, conversation, record.sessionId, binding.personId);
    restored += 1;
  }
  return restored;
}

export function relinkConversation(
  runtime: ServerRuntime,
  oldSessionId: string,
  newSessionId: string,
): void {
  for (const conversation of runtime.conversations.values()) {
    if (conversation.sessionId !== oldSessionId) continue;
    conversation.sessionId = newSessionId;
    if (conversation.personId) {
      attachLane(runtime, conversation, newSessionId, conversation.personId);
    }
  }
}
