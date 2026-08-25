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

/** Broadcasts only committed user/assistant TranscriptLines to Agent windows. */
export function wireTranscriptEvents(runtime: ServerRuntime): { close(): void } {
  return runtime.transcript.runtime.subscribeTranscriptEvents(async (event) => {
    await syncConversationViews(runtime);
    if (event.kind !== 'transcript-line.appended' || event.transcriptLineId === undefined) return;
    const [lineResult, sessionResult, sendResult] = await Promise.all([
      runtime.transcript.runtime.listTranscriptLines({ sessionId: event.sessionId }),
      runtime.transcript.runtime.listProviderSessions(),
      runtime.transcript.runtime.listSendJournals(),
    ]);
    if (lineResult.kind !== 'ok' || sessionResult.kind !== 'ok' || sendResult.kind !== 'ok') return;
    const line = lineResult.value.find((candidate) => candidate.id === event.transcriptLineId);
    if (line === undefined || (line.role !== 'user' && line.role !== 'assistant')) return;
    const session = sessionResult.value.find((candidate) => candidate.id === event.sessionId);
    if (session?.agentId === undefined) return;
    const conversation = [...runtime.conversations.values()].find((candidate) =>
      candidate.agentId === session.agentId && !candidate.archived);
    if (conversation === undefined) return;
    const clientOpId = sendResult.value.flatMap((journal) =>
      journal.attempts.some((attempt) => attempt.confirmedLineId === line.id)
        ? [journal.clientOpId] : [])[0];
    conversation.lastActivityAt = line.providerOccurredAt ?? line.createdAt;
    runtime.broadcast('message', {
      id: line.id,
      conversationId: conversation.id,
      senderId: line.role === 'user' ? 'me' : conversation.personId ?? conversation.agentId,
      text: line.text ?? '',
      createdAt: line.providerOccurredAt ?? line.createdAt,
      pending: false,
      ...(clientOpId === undefined ? {} : { clientOpId }),
    });
  });
}
