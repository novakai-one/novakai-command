import type { SendAttempt, SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { ProviderSessionId, Timestamp } from '../../contract/types.js';
import { compareStrings } from '../../core/compare.js';

/** The journals a confirmation pass changed, and how many it confirmed. */
export interface ConfirmationResult {
  readonly changed: readonly SendJournal[];
  readonly confirmed: number;
}

type ConfirmOutcome =
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'confirmed';
      readonly journal: SendJournal;
      readonly lineId: TranscriptLine['id'];
    }
  | { readonly kind: 'indeterminate'; readonly journal: SendJournal };

/**
 * Matches one session's awaiting-transcript journals against fresh lines in
 * dispatch order: exactly one eligible line confirms, more than one is honest
 * indeterminate, none leaves the journal waiting for a later pass. A confirmed
 * line is consumed, so no line ever confirms two sends. Crash recovery: this
 * pass is pure — the caller persists the changed journals before applying
 * them, so a crash mid-confirm replays from the store on next open.
 */
export function confirmJournalsForLines(
  journals: ReadonlyMap<string, SendJournal>,
  sessionId: ProviderSessionId,
  lines: readonly TranscriptLine[],
  updatedAt: Timestamp,
): ConfirmationResult {
  const candidates = confirmationCandidates(lines, sessionId, usedLineIds(journals));
  const pending = [...journals.values()]
    .filter((journal) => journal.targetSessionId === sessionId
      && journal.state === 'awaiting-transcript')
    .sort(byDispatchOrder);
  const changed: SendJournal[] = [];
  let confirmed = 0;
  for (const journal of pending) {
    const outcome = confirmOne(journal, candidates, updatedAt);
    applyOutcome(outcome, changed);
    if (outcome.kind !== 'confirmed') continue;
    confirmed += 1;
    consumeLine(candidates, outcome.lineId);
  }
  return { changed, confirmed };
}

/** A settled outcome joins the changed list; a skip does not. */
const applyOutcome = (outcome: ConfirmOutcome, changed: SendJournal[]): void => {
  if (outcome.kind === 'skipped') return;
  changed.push(outcome.journal);
};

/** The confirming line leaves the candidate pool, so no line confirms two sends. */
const consumeLine = (candidates: TranscriptLine[], lineId: TranscriptLine['id']): void => {
  const found = candidates.findIndex((line) => line.id === lineId);
  if (found < 0) return;
  candidates.splice(found, 1);
};

/** Line ids already consumed by a confirmed attempt, so no line confirms two sends. */
const usedLineIds = (journals: ReadonlyMap<string, SendJournal>): ReadonlySet<string> =>
  new Set([...journals.values()].flatMap((journal) =>
    journal.attempts.flatMap((attempt) =>
      attempt.confirmedLineId === undefined ? [] : [attempt.confirmedLineId])));

/** This session's user lines not yet consumed, in source order — the order the provider wrote them. */
const confirmationCandidates = (
  lines: readonly TranscriptLine[],
  sessionId: ProviderSessionId,
  used: ReadonlySet<string>,
): TranscriptLine[] =>
  lines
    .filter((line) => line.sessionId === sessionId && line.role === 'user' && !used.has(line.id))
    .sort((left, right) =>
      left.sourcePosition.sourceEpoch - right.sourcePosition.sourceEpoch
      || left.sourcePosition.offset - right.sourcePosition.offset);

/** First-dispatched first; the journal id breaks ties, in code-unit order every host agrees on. */
const byDispatchOrder = (left: SendJournal, right: SendJournal): number => {
  const leftAt = left.attempts.at(-1)?.dispatchedAt ?? left.createdAt;
  const rightAt = right.attempts.at(-1)?.dispatchedAt ?? right.createdAt;
  return compareStrings(leftAt, rightAt) || compareStrings(left.id, right.id);
};

/** Settles one awaiting journal against the candidate lines: confirmed, ambiguous, or untouched. */
const confirmOne = (
  journal: SendJournal,
  candidates: readonly TranscriptLine[],
  updatedAt: Timestamp,
): ConfirmOutcome => {
  const attempt = journal.attempts.at(-1);
  if (attempt?.correlationHint === undefined) return { kind: 'skipped' };
  return settleAttempt(journal, attempt, candidates, updatedAt);
};

/** The attempt's matching lines decide: exactly one confirms, more than one is indeterminate. */
const settleAttempt = (
  journal: SendJournal,
  attempt: SendAttempt,
  candidates: readonly TranscriptLine[],
  updatedAt: Timestamp,
): ConfirmOutcome => {
  const [line, other] = candidates.filter((candidate) => isEligibleLine(candidate, attempt));
  if (line === undefined) return { kind: 'skipped' };
  if (other !== undefined) {
    return { kind: 'indeterminate', journal: ambiguousJournal(journal, attempt, updatedAt) };
  }
  return {
    kind: 'confirmed',
    journal: confirmedJournal(journal, attempt, line.id, updatedAt),
    lineId: line.id,
  };
};

/** A line proves a dispatch when the hint matches and the line sits at or past the attempt's fence. */
const isEligibleLine = (line: TranscriptLine, attempt: SendAttempt): boolean => {
  if (line.correlationHint !== attempt.correlationHint) return false;
  if (attempt.sourceFence === undefined) {
    return (line.providerOccurredAt ?? line.createdAt) >= attempt.dispatchedAt;
  }
  return line.sourcePosition.sourceId === attempt.sourceFence.sourceId
    && atOrPastFence(line, attempt.sourceFence);
};

/** Source order reaches or passes the fence only in the same epoch at a later offset, or a newer one. */
const atOrPastFence = (
  line: TranscriptLine,
  fence: NonNullable<SendAttempt['sourceFence']>,
): boolean =>
  line.sourcePosition.sourceEpoch > fence.sourceEpoch
  || (line.sourcePosition.sourceEpoch === fence.sourceEpoch
    && line.sourcePosition.offset >= fence.offset);

/** The journal settled as confirmed by one transcript line; the confirmed attempt is the last one. */
const confirmedJournal = (
  journal: SendJournal,
  attempt: SendAttempt,
  lineId: TranscriptLine['id'],
  updatedAt: Timestamp,
): SendJournal => ({
  ...journal,
  state: 'confirmed',
  updatedAt,
  attempts: withLastAttempt(journal, {
    ...attempt,
    state: 'confirmed',
    confirmedLineId: lineId,
  }),
});

/** Two or more lines could be the dispatch, so the honest state is indeterminate. */
const ambiguousJournal = (
  journal: SendJournal,
  attempt: SendAttempt,
  updatedAt: Timestamp,
): SendJournal => ({
  ...journal,
  state: 'indeterminate',
  updatedAt,
  attempts: withLastAttempt(journal, {
    ...attempt,
    state: 'indeterminate',
    failure: 'TranscriptCorrelationAmbiguous',
  }),
});

/** Replaces the final attempt — the one a confirmation pass always settles. */
const withLastAttempt = (journal: SendJournal, attempt: SendAttempt): readonly SendAttempt[] =>
  [...journal.attempts.slice(0, -1), attempt];
