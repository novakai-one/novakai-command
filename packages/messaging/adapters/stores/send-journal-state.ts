import type {
  AcceptSendResult,
  SendTransitionInput,
  SendTransitionResult,
} from '../../contract/ports/transcript-store.js';
import type { SendAttempt, SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { ProviderSessionId } from '../../contract/types.js';

export interface PersistedSendMutation {
  readonly sequence: number;
  readonly journals: readonly SendJournal[];
}

type Persist = (journals: readonly SendJournal[]) => Promise<void>;

const sameRequest = (left: SendJournal, right: SendJournal): boolean =>
  left.requestHash === right.requestHash
  && left.conversationId === right.conversationId
  && left.issuedBy === right.issuedBy
  && left.targetAgentId === right.targetAgentId;

const updatedAttempt = (
  attempts: readonly SendAttempt[],
  next: SendAttempt | undefined,
): readonly SendAttempt[] => {
  if (next === undefined) return attempts;
  const found = attempts.findIndex((attempt) => attempt.attemptId === next.attemptId);
  if (found < 0) return [...attempts, next];
  return attempts.map((attempt, index) => index === found ? next : attempt);
};

const terminal = (journal: SendJournal): boolean =>
  journal.state === 'confirmed' || journal.state === 'failed' || journal.state === 'indeterminate';

/** Serialized SendJournal semantics shared by memory and Foundation adapters. */
export class SendJournalState {
  private readonly journals = new Map<string, SendJournal>();
  private readonly clientOps = new Map<string, string>();
  private mutationTail: Promise<unknown> = Promise.resolve();

  restore(mutations: readonly PersistedSendMutation[]): void {
    for (const mutation of [...mutations].sort((left, right) => left.sequence - right.sequence)) {
      this.apply(mutation.journals);
    }
  }

  accept(journal: SendJournal, persist?: Persist): Promise<AcceptSendResult> {
    return this.serialized(async () => {
      const existingId = this.clientOps.get(journal.clientOpId);
      const existing = existingId === undefined ? undefined : this.journals.get(existingId);
      if (existing !== undefined) {
        if (!sameRequest(existing, journal)) {
          throw new Error(`Send client operation ${journal.clientOpId} conflicts`);
        }
        return { journal: existing, duplicate: true };
      }
      if (persist !== undefined) await persist([journal]);
      this.apply([journal]);
      return { journal, duplicate: false };
    });
  }

  transition(input: SendTransitionInput, persist?: Persist): Promise<SendTransitionResult> {
    return this.serialized(async () => {
      const current = this.required(input.sendId);
      if (current.state !== input.expectedState) {
        if (current.state === input.state) return { journal: current, changed: false };
        throw new Error(`Send ${input.sendId} state is ${current.state}, expected ${input.expectedState}`);
      }
      const next: SendJournal = {
        ...current,
        state: input.state,
        updatedAt: input.updatedAt,
        attempts: updatedAttempt(current.attempts, input.attempt),
      };
      if (persist !== undefined) await persist([next]);
      this.apply([next]);
      return { journal: next, changed: true };
    });
  }

  bindAgentSession(
    agentId: string,
    sessionId: ProviderSessionId,
    updatedAt: string,
    persist?: Persist,
  ): Promise<number> {
    return this.serialized(async () => {
      const changed = [...this.journals.values()].flatMap((journal): SendJournal[] => {
        if (terminal(journal) || journal.targetAgentId !== agentId) return [];
        if (journal.targetSessionId !== undefined && journal.targetSessionId !== sessionId) {
          throw new Error(`Send ${journal.id} already targets another ProviderSession`);
        }
        if (journal.targetSessionId === sessionId && journal.state !== 'awaiting-session-assignment') return [];
        const attempts = journal.attempts.map((attempt) =>
          attempt.state === 'awaiting-session-assignment'
            ? { ...attempt, state: 'awaiting-transcript' as const }
            : attempt);
        return [{
          ...journal,
          targetSessionId: sessionId,
          updatedAt: updatedAt as SendJournal['updatedAt'],
          state: journal.state === 'awaiting-session-assignment'
            ? 'awaiting-transcript' : journal.state,
          attempts,
        }];
      });
      if (changed.length === 0) return 0;
      if (persist !== undefined) await persist(changed);
      this.apply(changed);
      return changed.length;
    });
  }

  confirmForLines(
    sessionId: ProviderSessionId,
    lines: readonly TranscriptLine[],
    updatedAt: string,
    persist?: Persist,
  ): Promise<number> {
    return this.serialized(async () => {
      const used = new Set([...this.journals.values()].flatMap((journal) =>
        journal.attempts.flatMap((attempt) => attempt.confirmedLineId === undefined
          ? [] : [attempt.confirmedLineId])));
      const candidates = lines
        .filter((line) => line.sessionId === sessionId && line.role === 'user' && !used.has(line.id))
        .sort((left, right) => left.sourcePosition.sourceEpoch - right.sourcePosition.sourceEpoch
          || left.sourcePosition.offset - right.sourcePosition.offset);
      const pending = [...this.journals.values()]
        .filter((journal) => journal.targetSessionId === sessionId && journal.state === 'awaiting-transcript')
        .sort((left, right) => {
          const leftAt = left.attempts.at(-1)?.dispatchedAt ?? left.createdAt;
          const rightAt = right.attempts.at(-1)?.dispatchedAt ?? right.createdAt;
          return leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id);
        });
      const changed: SendJournal[] = [];
      let confirmed = 0;
      for (const journal of pending) {
        const attempt = journal.attempts.at(-1);
        if (attempt?.correlationHint === undefined) continue;
        const eligible = candidates.filter((line) => {
          if (line.correlationHint !== attempt.correlationHint) return false;
          if (attempt.sourceFence === undefined) {
            return (line.providerOccurredAt ?? line.createdAt)
              .localeCompare(attempt.dispatchedAt) >= 0;
          }
          return line.sourcePosition.sourceId === attempt.sourceFence.sourceId
            && (line.sourcePosition.sourceEpoch > attempt.sourceFence.sourceEpoch
              || line.sourcePosition.sourceEpoch === attempt.sourceFence.sourceEpoch
                && line.sourcePosition.offset >= attempt.sourceFence.offset);
        });
        if (eligible.length === 0) continue;
        if (eligible.length > 1) {
          changed.push({
            ...journal,
            state: 'indeterminate',
            updatedAt: updatedAt as SendJournal['updatedAt'],
            attempts: updatedAttempt(journal.attempts, {
              ...attempt,
              state: 'indeterminate',
              failure: 'TranscriptCorrelationAmbiguous',
            }),
          });
          continue;
        }
        const line = eligible[0]!;
        const lineIndex = candidates.findIndex((candidate) => candidate.id === line.id);
        if (lineIndex >= 0) candidates.splice(lineIndex, 1);
        used.add(line.id);
        confirmed += 1;
        changed.push({
          ...journal,
          state: 'confirmed',
          updatedAt: updatedAt as SendJournal['updatedAt'],
          attempts: updatedAttempt(journal.attempts, {
            ...attempt,
            state: 'confirmed',
            confirmedLineId: line.id,
          }),
        });
      }
      if (changed.length === 0) return 0;
      if (persist !== undefined) await persist(changed);
      this.apply(changed);
      return confirmed;
    });
  }

  list(): readonly SendJournal[] {
    return [...this.journals.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  private required(id: string): SendJournal {
    const journal = this.journals.get(id);
    if (journal === undefined) throw new Error(`Unknown SendJournal ${id}`);
    return journal;
  }

  private apply(journals: readonly SendJournal[]): void {
    for (const journal of journals) {
      this.journals.set(journal.id, journal);
      this.clientOps.set(journal.clientOpId, journal.id);
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}
