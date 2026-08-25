import type {
  AgentConversationMessage,
  AgentConversationMessagesQuery,
} from '../../contract/conversations.js';
import type { ProviderNormalizer } from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { ProviderName } from '../../contract/types.js';

/**
 * Projects provider-owned evidence into the sole host-facing conversation stream.
 * Provider adapters own semantic selection; hosts never inspect transcript formats.
 */
export async function listAgentConversationMessages(
  store: TranscriptStore,
  normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>,
  input: AgentConversationMessagesQuery,
): Promise<readonly AgentConversationMessage[]> {
  const sessions = (await store.listProviderSessions())
    .filter((session) => session.agentId === input.agentId);
  const sessionOrder = new Map(sessions.map((session) => [session.id, session.createdAt]));
  const lines = (await Promise.all(sessions.map((session) =>
    store.listTranscriptLines({ sessionId: session.id })))).flat();
  const journals = await store.listSendJournals();
  const clientOpByLine = new Map(journals.flatMap((journal) =>
    journal.attempts.flatMap((attempt) => attempt.confirmedLineId === undefined
      ? [] : [[attempt.confirmedLineId, journal.clientOpId] as const])));

  return lines
    .sort((left, right) =>
      (sessionOrder.get(left.sessionId) ?? '').localeCompare(
        sessionOrder.get(right.sessionId) ?? '',
      )
      || left.sourcePosition.sourceEpoch - right.sourcePosition.sourceEpoch
      || left.sourcePosition.offset - right.sourcePosition.offset)
    .flatMap((line): AgentConversationMessage[] => {
      const normalized = normalizers[line.provider].normalize({
        raw: line.raw,
        offset: line.sourcePosition.offset,
        nextOffset: line.sourcePosition.nextOffset,
      }, line.turnIndex);
      if (normalized.audience !== 'conversation'
        || (normalized.role !== 'user' && normalized.role !== 'assistant')
        || normalized.text.trim() === '') return [];
      return [{
        id: line.id,
        role: normalized.role,
        text: normalized.text,
        occurredAt: normalized.providerOccurredAt ?? line.createdAt,
        ...(clientOpByLine.has(line.id)
          ? { clientOpId: clientOpByLine.get(line.id)! } : {}),
      }];
    });
}
