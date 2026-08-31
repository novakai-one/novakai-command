import type {
  AgentConversationMessage,
  AgentConversationMessagesQuery,
} from '../../contract/conversations.js';
import type { ProviderNormalizer } from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptLineQuery } from '../../contract/ports/transcript-store.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { ProviderName, TranscriptLineId } from '../../contract/types.js';
import { present } from '../sparse.js';
import { compareStrings } from '../compare.js';

/** The three committed lists the conversation message surfaces read — nothing else. */
export interface ConversationMessageReads {
  listProviderSessions(): Promise<readonly ProviderSession[]>;
  listTranscriptLines(query?: TranscriptLineQuery): Promise<readonly TranscriptLine[]>;
  listSendJournals(): Promise<readonly SendJournal[]>;
}

/**
 * Answers the host's one conversation question: the human-readable message
 * stream for one agent, oldest first. Reads the transcript lines of every
 * session the agent owns and runs them through the shared projection below,
 * so a snapshot and a live stream event can never disagree. Providers own the
 * semantic selection through their normalizer; hosts never inspect transcript
 * formats.
 */
export async function listAgentConversationMessages(
  store: ConversationMessageReads,
  normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>,
  input: AgentConversationMessagesQuery,
): Promise<readonly AgentConversationMessage[]> {
  const sessions = (await store.listProviderSessions())
    .filter((session) => session.agentId === input.agentId);
  const sessionOrder = new Map(sessions.map((session) => [session.id, session.createdAt]));
  const lines = (await Promise.all(sessions.map((session) =>
    store.listTranscriptLines({ sessionId: session.id })))).flat();
  const journals = await store.listSendJournals();
  return projectAgentConversationMessages(
    lines.sort(bySessionThenPosition(sessionOrder)), normalizers, journals,
  );
}

/** Oldest session first (session id breaks ties); within one session, source order. */
const bySessionThenPosition = (sessionOrder: ReadonlyMap<string, string>) =>
  (left: TranscriptLine, right: TranscriptLine): number =>
    compareStrings(
      sessionOrder.get(left.sessionId) ?? '',
      sessionOrder.get(right.sessionId) ?? '',
    )
    || compareStrings(left.sessionId, right.sessionId)
    || left.sourcePosition.sourceEpoch - right.sourcePosition.sourceEpoch
    || left.sourcePosition.offset - right.sourcePosition.offset;

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
    ...present('clientOpId', clientOpByLine.get(line.id)),
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
): ReadonlyMap<TranscriptLineId, string> {
  const lineIndex = new Map(lines.map((line, index) => [line.id, index]));
  const claimed = new Set<TranscriptLineId>();
  const clientOpByLine = new Map<TranscriptLineId, string>();
  const ordered = [...journals].sort((left, right) => compareStrings(left.createdAt, right.createdAt));
  for (const journal of ordered) {
    claimFirstAttempt(journal, lineIndex, claimed, clientOpByLine, projected);
  }
  return clientOpByLine;
}

/**
 * The first attempt of one journal that can claim a line wins; later attempts
 * of the same send never re-claim.
 */
function claimFirstAttempt(
  journal: SendJournal,
  lineIndex: ReadonlyMap<TranscriptLineId, number>,
  claimed: Set<TranscriptLineId>,
  clientOpByLine: Map<TranscriptLineId, string>,
  projected: readonly ProjectedConversationLine[],
): void {
  for (const attempt of journal.attempts) {
    const claim = claimableLine(journal, attempt, lineIndex, claimed, projected);
    if (claim === undefined) continue;
    claimed.add(claim);
    clientOpByLine.set(claim, journal.clientOpId);
    return;
  }
}

type SendAttempt = SendJournal['attempts'][number];

/**
 * The line one send attempt claims: the first unclaimed canonical user
 * message at or after the attempt's confirming line, in the target session.
 */
function claimableLine(
  journal: SendJournal,
  attempt: SendAttempt,
  lineIndex: ReadonlyMap<TranscriptLineId, number>,
  claimed: ReadonlySet<TranscriptLineId>,
  projected: readonly ProjectedConversationLine[],
): TranscriptLineId | undefined {
  if (attempt.confirmedLineId === undefined) return undefined;
  const confirmedIndex = lineIndex.get(attempt.confirmedLineId);
  if (confirmedIndex === undefined) return undefined;
  return projected.find((entry) =>
    isClaimableUserMessage(entry, journal, lineIndex, claimed, confirmedIndex))?.line.id;
}

/** True when a projected line is the display identity a confirmation can claim. */
const isClaimableUserMessage = (
  entry: ProjectedConversationLine,
  journal: SendJournal,
  lineIndex: ReadonlyMap<TranscriptLineId, number>,
  claimed: ReadonlySet<TranscriptLineId>,
  confirmedIndex: number,
): boolean =>
  entry.message.role === 'user'
  && !claimed.has(entry.line.id)
  && entry.line.sessionId === journal.targetSessionId
  && (lineIndex.get(entry.line.id) ?? -1) >= confirmedIndex;
