import type {
  AcceptSendResult,
  SendTransitionInput,
  SendTransitionResult,
} from '../../contract/ports/transcript-store.js';
import type { SendAttempt, SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { ProviderSessionId, Timestamp } from '../../contract/types.js';
import { MessagingError } from '../../contract/types.js';
import { compareStrings } from '../../core/compare.js';
import { confirmJournalsForLines } from './send-confirmation.js';

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

/**
 * A transition whose expected state is already stale: the journal sitting in
 * the target state is a harmless repeat, anywhere else is a typed race.
 */
const settledTransition = (
  current: SendJournal,
  input: SendTransitionInput,
): SendTransitionResult => {
  if (current.state === input.state) return { journal: current, changed: false };
  throw new MessagingError('ConcurrentModification', {
    message: `Send ${input.sendId} state is ${current.state}, expected ${input.expectedState}`,
    fields: { sendId: input.sendId, expected: input.expectedState, actual: current.state },
  });
};

/**
 * Serialized SendJournal semantics shared by memory and Foundation adapters.
 * Crash recovery: persist precedes apply, so a crash mid-step replays from
 * the store on next open.
 */
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
      const existing = this.duplicateOf(journal);
      if (existing !== undefined) return { journal: existing, duplicate: true };
      if (persist !== undefined) await persist([journal]);
      this.apply([journal]);
      return { journal, duplicate: false };
    });
  }

  /**
   * The stored journal for this client op: identical means a duplicate
   * accept, different content under the same op is a typed conflict.
   */
  private duplicateOf(journal: SendJournal): SendJournal | undefined {
    const existingId = this.clientOps.get(journal.clientOpId);
    if (existingId === undefined) return undefined;
    const existing = this.journals.get(existingId);
    if (existing === undefined) return undefined;
    if (sameRequest(existing, journal)) return existing;
    throw new MessagingError('IdempotencyConflict', {
      message: `Send client operation ${journal.clientOpId} conflicts`,
      fields: { clientOpId: journal.clientOpId, sendId: existing.id },
    });
  }

  transition(input: SendTransitionInput, persist?: Persist): Promise<SendTransitionResult> {
    return this.serialized(async () => {
      const current = this.required(input.sendId);
      if (current.state !== input.expectedState) return settledTransition(current, input);
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
    updatedAt: Timestamp,
    persist?: Persist,
  ): Promise<number> {
    return this.serialized(async () => {
      const changed = [...this.journals.values()].flatMap((journal) =>
        bindingFor(journal, agentId, sessionId, updatedAt));
      if (changed.length === 0) return 0;
      if (persist !== undefined) await persist(changed);
      this.apply(changed);
      return changed.length;
    });
  }

  confirmForLines(
    sessionId: ProviderSessionId,
    lines: readonly TranscriptLine[],
    updatedAt: Timestamp,
    persist?: Persist,
  ): Promise<number> {
    return this.serialized(async () => {
      const { changed, confirmed } = confirmJournalsForLines(
        this.journals, sessionId, lines, updatedAt,
      );
      if (changed.length === 0) return 0;
      if (persist !== undefined) await persist(changed);
      this.apply(changed);
      return confirmed;
    });
  }

  list(): readonly SendJournal[] {
    return [...this.journals.values()].sort((left, right) =>
      compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id));
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
    const chained = this.mutationTail.then(operation, operation);
    this.mutationTail = chained.then(() => undefined, () => undefined);
    return chained;
  }
}

/** The bind one journal needs for this assignment, or none. */
const bindingFor = (
  journal: SendJournal,
  agentId: string,
  sessionId: ProviderSessionId,
  updatedAt: Timestamp,
): SendJournal[] => {
  if (!needsBinding(journal, agentId, sessionId)) return [];
  return [boundToSession(journal, sessionId, updatedAt)];
};

/** A journal binds only when it is live, targets this agent, and is not already settled here. */
const needsBinding = (
  journal: SendJournal,
  agentId: string,
  sessionId: ProviderSessionId,
): boolean => {
  if (terminal(journal) || journal.targetAgentId !== agentId) return false;
  if (journal.targetSessionId === undefined) return true;
  requireSameSession(journal, sessionId);
  return journal.state === 'awaiting-session-assignment';
};

/** A journal bound to a different session can never be rebound — a typed conflict. */
const requireSameSession = (journal: SendJournal, sessionId: ProviderSessionId): void => {
  if (journal.targetSessionId === sessionId) return;
  throw new MessagingError('IdempotencyConflict', {
    message: `Send ${journal.id} already targets another ProviderSession`,
    fields: { sendId: journal.id, bound: journal.targetSessionId, assigned: sessionId, conflict: 'session-binding' },
  });
};

/** The journal rebound to its session, with any waiting attempt advanced to await the transcript. */
const boundToSession = (
  journal: SendJournal,
  sessionId: ProviderSessionId,
  updatedAt: Timestamp,
): SendJournal => ({
  ...journal,
  targetSessionId: sessionId,
  updatedAt,
  state: boundState(journal.state),
  attempts: journal.attempts.map(advanceAttempt),
});

/** Assignment advances only a journal still waiting for a session; every other state keeps its course. */
const boundState = (state: SendJournal['state']): SendJournal['state'] => {
  if (state === 'awaiting-session-assignment') return 'awaiting-transcript';
  return state;
};

/** The same advance at attempt granularity. */
const advanceAttempt = (attempt: SendAttempt): SendAttempt => {
  if (attempt.state !== 'awaiting-session-assignment') return attempt;
  return { ...attempt, state: 'awaiting-transcript' };
};
