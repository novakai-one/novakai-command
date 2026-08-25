import type {
  AgentConversationMessage,
  AgentConversationMessagesQuery,
} from '../../contract/conversations.js';
import type { ProviderNormalizer } from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { ProviderName } from '../../contract/types.js';

/**
 * The only TranscriptLine-to-conversation projection. Snapshot reads and live
 * delivery both pass through this function, so provider noise cannot diverge.
 */
function projectAgentConversationMessage(
  line: TranscriptLine,
  normalizer: ProviderNormalizer,
): AgentConversationMessage | null {
  const normalized = normalizer.normalize({
    raw: line.raw,
    offset: line.sourcePosition.offset,
    nextOffset: line.sourcePosition.nextOffset,
  }, line.turnIndex);
  if (normalized.audience !== 'conversation'
    || (normalized.role !== 'user' && normalized.role !== 'assistant')
    || normalized.text.trim() === '') return null;
  return {
    id: line.id,
    role: normalized.role,
    text: normalized.text,
    occurredAt: normalized.providerOccurredAt ?? line.createdAt,
  };
}

interface ProjectedConversationLine {
  readonly line: TranscriptLine;
  readonly message: AgentConversationMessage;
}

/**
 * Correlates the accepted operation with the first canonical user row at or
 * after its confirmed provider evidence. Internal provider wrappers may be
 * the confirmation line, so confirmedLineId alone is not a display identity.
 */
function correlateClientOperations(
  lines: readonly TranscriptLine[],
  projected: readonly ProjectedConversationLine[],
  journals: readonly SendJournal[],
): ReadonlyMap<string, string> {
  const lineIndex = new Map(lines.map((line, index) => [line.id, index]));
  const claimed = new Set<string>();
  const clientOpByLine = new Map<string, string>();
  for (const journal of [...journals].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt))) {
    for (const attempt of journal.attempts) {
      if (attempt.confirmedLineId === undefined) continue;
      const confirmedIndex = lineIndex.get(attempt.confirmedLineId);
      if (confirmedIndex === undefined) continue;
      const candidate = projected.find((entry) =>
        entry.message.role === 'user'
        && !claimed.has(entry.line.id)
        && entry.line.sessionId === journal.targetSessionId
        && (lineIndex.get(entry.line.id) ?? -1) >= confirmedIndex);
      if (candidate === undefined) continue;
      claimed.add(candidate.line.id);
      clientOpByLine.set(candidate.line.id, journal.clientOpId);
      break;
    }
  }
  return clientOpByLine;
}

/** Canonical projection shared by snapshot queries and live subscriptions. */
export function projectAgentConversationMessages(
  lines: readonly TranscriptLine[],
  normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>,
  journals: readonly SendJournal[],
): readonly AgentConversationMessage[] {
  const projected = lines.flatMap((line): ProjectedConversationLine[] => {
    const message = projectAgentConversationMessage(line, normalizers[line.provider]);
    return message === null ? [] : [{ line, message }];
  });
  const clientOpByLine = correlateClientOperations(lines, projected, journals);
  return projected.map(({ line, message }) => ({
    ...message,
    ...(clientOpByLine.has(line.id) ? { clientOpId: clientOpByLine.get(line.id)! } : {}),
  }));
}

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
  const orderedLines = lines
    .sort((left, right) =>
      (sessionOrder.get(left.sessionId) ?? '').localeCompare(
        sessionOrder.get(right.sessionId) ?? '',
      )
      || left.sourcePosition.sourceEpoch - right.sourcePosition.sourceEpoch
      || left.sourcePosition.offset - right.sourcePosition.offset);
  return projectAgentConversationMessages(orderedLines, normalizers, journals);
}
