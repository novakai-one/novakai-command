import type { ServerRuntime } from '../methods/runtime.js';

async function syncConversationViews(runtime: ServerRuntime): Promise<void> {
  const listed = await runtime.transcript.runtime.listConversationViews();
  if (listed.kind === 'error') return;
  for (const view of listed.value) {
    if (runtime.conversations.has(view.id)) continue;
    const conversation = {
      id: view.id,
      address: view.address ?? (view.agentId === undefined ? '' : `agent:${view.agentId}`),
      title: view.titleOverride ?? view.id,
      kind: view.agentId === undefined ? 'direct' as const : 'agent' as const,
      pinned: view.pinned,
      archived: view.archived,
      lastActivityAt: view.lastActivityAt,
      ...(view.agentId === undefined ? {} : { agentId: view.agentId }),
      ...(view.provider === undefined ? {} : { provider: view.provider }),
      ...(view.lastReadLineId === undefined ? {} : { lastReadMessageId: view.lastReadLineId }),
    };
    runtime.conversations.set(view.id, conversation);
    runtime.broadcast('conversation', {
      id: conversation.id,
      threadId: conversation.address,
      title: conversation.title,
      kind: conversation.kind,
      pinned: conversation.pinned,
      archived: conversation.archived,
      lastActivityAt: conversation.lastActivityAt,
      agentId: conversation.agentId,
    });
  }
}

/** Maps Messaging's canonical live stream onto Server conversation identities. */
export function wireTranscriptEvents(runtime: ServerRuntime): { close(): void } {
  return runtime.transcript.runtime.subscribeAgentConversationMessages(async ({ agentId, message }) => {
    await syncConversationViews(runtime);
    const conversation = [...runtime.conversations.values()].find((candidate) =>
      candidate.agentId === agentId && !candidate.archived);
    if (conversation === undefined) return;
    conversation.lastActivityAt = message.occurredAt;
    runtime.broadcast('message', {
      id: message.id,
      conversationId: conversation.id,
      senderId: message.role === 'user' ? 'me' : conversation.personId ?? conversation.agentId,
      text: message.text,
      createdAt: message.occurredAt,
      pending: false,
      ...(message.clientOpId === undefined ? {} : { clientOpId: message.clientOpId }),
    });
  });
}
