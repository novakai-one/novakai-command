import {
  b3err, b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type AuthenticatedPrincipal, type B3Page, type B3PrincipalId, type B3Result,
  type CommandReceiptId, type EventCursor,
} from '@novakai/foundation/contract';
import {
  deriveDeadlineWatchEvaluationId, deriveEventWatchEvaluationId,
  type WatchEvaluationId,
  type WatchEvaluationProgress,
  type WatchEvaluationProgressFilter,
  type WatchEvaluationRuleOutcome,
  type WatchEvaluationTrigger,
  type WatchDeadline,
  type WatchRuleId,
} from '../contract/index.js';
import type { SupervisionStore } from './store.js';

export const SUPERVISION_WATCH_REPAIR_SCOPE = 'supervision:watch:repair';

export interface StartEventEvaluationInput {
  readonly commandReceiptId: CommandReceiptId;
  readonly eventId: string;
  readonly orderedWatchRuleIds: readonly WatchRuleId[];
}

export interface StartDeadlineEvaluationInput {
  readonly commandReceiptId: CommandReceiptId;
  readonly deadline: WatchDeadline & {
    readonly creationRecordVersion: NonNullable<WatchDeadline['creationRecordVersion']>;
  };
}

export interface ProgressEntry {
  readonly watchRuleId: WatchRuleId;
  readonly evaluatedRecordVersion: WatchEvaluationProgress['recordVersion'];
  readonly outcome: WatchEvaluationRuleOutcome;
}

function authorized(principal: AuthenticatedPrincipal): B3Result<null> {
  return principal.verifiedScopes.includes(SUPERVISION_WATCH_REPAIR_SCOPE as never)
    ? b3ok(null)
    : b3fail(b3err(
        'PermissionDenied',
        'watch evaluation repair scope is required',
        { requiredScope: SUPERVISION_WATCH_REPAIR_SCOPE },
        false,
      ));
}

/** Create or resume the one durable progress record owned by an event receipt. */
export async function startEventEvaluation(
  store: SupervisionStore,
  principal: B3PrincipalId,
  input: StartEventEvaluationInput,
): Promise<B3Result<WatchEvaluationProgress>> {
  const id = deriveEventWatchEvaluationId(input.commandReceiptId);
  const prior = await store.read<WatchEvaluationProgress>('watchEvaluation', id);
  if (!prior.ok) return prior;
  if (prior.value !== null) {
    if (prior.value.trigger.kind !== 'event'
      || prior.value.trigger.eventId !== input.eventId
      || prior.value.commandReceiptId !== input.commandReceiptId) {
      return b3fail(b3err(
        'IdempotencyConflict',
        'watch evaluation identity already names different trigger facts',
        { watchEvaluationId: id },
        false,
      ));
    }
    return b3ok(prior.value);
  }
  return store.create<WatchEvaluationProgress>(principal, {
    kind: 'watchEvaluation',
    id,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: principal,
    commandReceiptId: input.commandReceiptId,
    trigger: { kind: 'event', eventId: input.eventId },
    orderedWatchRuleIds: [...input.orderedWatchRuleIds].sort(
      (left, right) => String(left).localeCompare(String(right)),
    ),
    attemptOrdinal: 0,
    completed: [],
    nextRuleIndex: 0,
    state: 'running',
  }, deriveClientOpId(`b3v4:start-watch-evaluation:${String(id)}`));
}

/** Create or adopt the progress identity of one immutable ordinary arming. */
export async function startDeadlineEvaluation(
  store: SupervisionStore,
  principal: B3PrincipalId,
  input: StartDeadlineEvaluationInput,
): Promise<B3Result<WatchEvaluationProgress>> {
  const { deadline } = input;
  const evaluationId = deriveDeadlineWatchEvaluationId(
    deadline.id,
    deadline.creationRecordVersion,
  );
  const prior = await store.read<WatchEvaluationProgress>('watchEvaluation', evaluationId);
  if (!prior.ok) return prior;
  if (prior.value !== null) return b3ok(prior.value);
  return store.create<WatchEvaluationProgress>(principal, {
    kind: 'watchEvaluation',
    id: evaluationId,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: principal,
    commandReceiptId: input.commandReceiptId,
    trigger: {
      kind: 'deadline',
      watchDeadlineId: deadline.id,
      deadlineCreationRecordVersion: deadline.creationRecordVersion,
    },
    orderedWatchRuleIds: [deadline.watchRuleId],
    attemptOrdinal: 0,
    completed: [],
    nextRuleIndex: 0,
    state: 'running',
  }, deriveClientOpId(`b3v4:start-deadline-evaluation:${String(evaluationId)}`));
}

export async function beginProgressAttempt(
  store: SupervisionStore,
  principal: B3PrincipalId,
  progress: WatchEvaluationProgress,
): Promise<B3Result<WatchEvaluationProgress>> {
  if (progress.state === 'running' && progress.completed.length === 0) return b3ok(progress);
  return store.update<WatchEvaluationProgress>(
    principal,
    progress.id,
    {
      attemptOrdinal: progress.attemptOrdinal + 1,
      nextRuleIndex: 0,
      state: 'running',
      recovery: undefined,
    },
    progress.recordVersion,
    deriveClientOpId(
      `b3v4:resume-watch-evaluation:${String(progress.id)}:${String(progress.attemptOrdinal + 1)}`,
    ),
  );
}

/** Append one attempt-scoped rule outcome to durable progress. */
export async function appendProgressOutcome(
  store: SupervisionStore,
  principal: B3PrincipalId,
  progress: WatchEvaluationProgress,
  entry: ProgressEntry,
): Promise<B3Result<WatchEvaluationProgress>> {
  return store.update<WatchEvaluationProgress>(
    principal,
    progress.id,
    {
      completed: [...progress.completed, {
        attemptOrdinal: progress.attemptOrdinal,
        watchRuleId: entry.watchRuleId,
        evaluatedRecordVersion: entry.evaluatedRecordVersion,
        outcome: entry.outcome,
      }],
      nextRuleIndex: progress.nextRuleIndex + 1,
    },
    progress.recordVersion,
    deriveClientOpId(
      `b3v4:watch-evaluation-outcome:${String(progress.id)}:${String(progress.attemptOrdinal)}`
        + `:${String(progress.nextRuleIndex)}:${String(entry.watchRuleId)}`,
    ),
  );
}

/** Advance past an isolated retryable breach while retaining first attribution. */
export async function advanceProgressRecovery(
  store: SupervisionStore,
  principal: B3PrincipalId,
  progress: WatchEvaluationProgress,
  recovery: NonNullable<WatchEvaluationProgress['recovery']>,
): Promise<B3Result<WatchEvaluationProgress>> {
  return store.update<WatchEvaluationProgress>(
    principal,
    progress.id,
    {
      nextRuleIndex: progress.nextRuleIndex + 1,
      recovery: progress.recovery ?? recovery,
    },
    progress.recordVersion,
    deriveClientOpId(
      `b3v4:watch-evaluation-recovery:${String(progress.id)}`
        + `:${String(progress.attemptOrdinal)}:${String(progress.nextRuleIndex)}`,
    ),
  );
}

export async function finishProgress(
  store: SupervisionStore,
  principal: B3PrincipalId,
  progress: WatchEvaluationProgress,
  recovery?: WatchEvaluationProgress['recovery'],
): Promise<B3Result<WatchEvaluationProgress>> {
  return store.update<WatchEvaluationProgress>(
    principal,
    progress.id,
    {
      state: recovery === undefined ? 'completed' : 'recovery-required',
      recovery,
      nextRuleIndex: progress.orderedWatchRuleIds.length,
    },
    progress.recordVersion,
    deriveClientOpId(
      `b3v4:finish-watch-evaluation:${String(progress.id)}:${String(progress.attemptOrdinal)}`
        + `:${recovery?.stage ?? 'completed'}`,
    ),
  );
}

export async function getWatchEvaluationProgress(
  store: SupervisionStore,
  principal: AuthenticatedPrincipal,
  id: WatchEvaluationId,
): Promise<B3Result<WatchEvaluationProgress | null>> {
  const access = authorized(principal);
  return access.ok ? store.read<WatchEvaluationProgress>('watchEvaluation', id) : access;
}

function cursorAfter(progress: WatchEvaluationProgress): EventCursor {
  return `watchEvaluation:${String(progress.id)}` as EventCursor;
}

function afterCursor(candidate: WatchEvaluationProgress, cursor: EventCursor | undefined): boolean {
  if (cursor === undefined) return true;
  return String(candidate.id) > String(cursor).replace(/^watchEvaluation:/u, '');
}

export async function listWatchEvaluationProgress(
  store: SupervisionStore,
  principal: AuthenticatedPrincipal,
  filter: WatchEvaluationProgressFilter,
): Promise<B3Result<B3Page<WatchEvaluationProgress>>> {
  const access = authorized(principal);
  if (!access.ok) return access;
  if (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 1_000) {
    return b3fail(b3err(
      'ValidationFailed', 'watch evaluation progress limit must be between 1 and 1000',
      { issues: [{ path: 'limit', message: 'must be between 1 and 1000' }] }, false,
    ));
  }
  const listed = await store.list<WatchEvaluationProgress>('watchEvaluation');
  if (!listed.ok) return listed;
  const matching = listed.value
    .filter((progress) => afterCursor(progress, filter.cursor))
    .filter((progress) => filter.watchRuleId === undefined
      || progress.orderedWatchRuleIds.includes(filter.watchRuleId))
    .filter((progress) => filter.triggerKind === undefined
      || progress.trigger.kind === filter.triggerKind)
    .filter((progress) => filter.state === undefined || progress.state === filter.state)
    .filter((progress) => filter.outcomeKind === undefined
      || progress.completed.some((entry) => entry.outcome.kind === filter.outcomeKind))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const items = matching.slice(0, filter.limit);
  const nextCursor = matching.length > items.length && items.length > 0
    ? cursorAfter(items[items.length - 1]!)
    : undefined;
  return b3ok({ items, ...(nextCursor === undefined ? {} : { nextCursor }), omissions: [] });
}

export function triggerOf(progress: WatchEvaluationProgress): WatchEvaluationTrigger {
  return progress.trigger;
}
