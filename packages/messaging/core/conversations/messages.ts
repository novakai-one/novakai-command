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
 * Answers the host's one conversation question: the human-readable message
 * stream for one agent, oldest first. Reads the transcript lines of every
 * session the agent owns and runs them through the shared projection below,
 * so a snapshot and a live stream event can never disagree. Providers own the
 * semantic selection through their normalizer; hosts never inspect transcript
 * formats.
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

/**
 * The single transcript-to-conversation projection. Both the snapshot query
 * above and the live stream in message-stream.ts call this function, so
 * provider noise is filtered in exactly one place and the two surfaces cannot
 * diverge.
 */
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

interface ProjectedConversationLine {
  readonly line: TranscriptLine;
  readonly message: AgentConversationMessage;
}

/**
 * Keeps one transcript line only when its provider says it belongs in the
 * human conversation: user and assistant text, nothing else.
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

/**
 * Matches each confirmed send to the first canonical user message at or after
 * the line that confirmed it. A provider's internal wrapper line can be the
 * confirmation evidence, so the confirmed line alone is not the display
 * identity — the correlation walks forward to the real user message.
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
