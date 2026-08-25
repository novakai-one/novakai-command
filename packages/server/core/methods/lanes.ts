/** Provider-session lane attachment and restart restoration. */

import type { Conversation, ServerRuntime } from './runtime.js';

/** Attach only legacy activity/advisory semantics; never message content. */
export function attachLane(
  runtime: ServerRuntime,
  conversation: Conversation,
  sessionId: string,
  personId: string,
): void {
  void conversation;
  void personId;
  runtime.agents.attachLiveLane({
    sessionId,
    address: `person:${runtime.human.personId}`,
  } as never);
}

/** Restore pre-transcript-first runtime sessions during the compatibility window. */
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

/** Relink one legacy conversation after its runtime session rotates. */
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
