// LANE B — durable deadline scheduler operations.
import {
  b3fail,
  b3ok,
  b3err,
  commandReceiptId,
  deriveClientOpId,
  type CommandContext,
  type B3Result,
  type SystemCommandContext,
  type PublicOperationName,
} from '@novakai/foundation/contract';
import {
  SUPERVISION_RECORD_WRITER,
  type ClaimDueDeadlinesInput,
  type DurableDriftState,
  type ResetDriftEpisodeInput,
  type WatchDeadline,
  type WatchRule,
} from '../../contract/index.js';
import type { SupervisionStore } from '../store.js';
import { startDeadlineEvaluation } from '../watch-evaluation-progress.js';

export interface DeadlineDependencies {
  readonly store: SupervisionStore;
  readonly clock: () => Date;
}

/** Move one armed deadline onto the durable scheduler claim rung. */
export async function claimDeadline(
  deps: DeadlineDependencies,
  deadline: WatchDeadline,
): Promise<B3Result<WatchDeadline>> {
  return deps.store.update<WatchDeadline>(
    SUPERVISION_RECORD_WRITER,
    deadline.id,
    {
      state: 'claimed',
      lateByMs: Math.max(0, deps.clock().getTime() - Date.parse(deadline.dueAt)),
    },
    deadline.recordVersion,
    deriveClientOpId(
      'b3v4:claim-watch-deadline:' + deadline.id + ':' + deadline.recordVersion,
    ),
  );
}

/** Human exact-CAS release of one escalated drift episode. */
export async function resetDriftEpisode(
  deps: DeadlineDependencies,
  context: CommandContext,
  input: ResetDriftEpisodeInput,
): Promise<B3Result<WatchDeadline>> {
  const deadline = await deps.store.read<WatchDeadline>(
    'watchDeadline', input.watchDeadlineId,
  );
  if (!deadline.ok) return b3fail(deadline.error);
  if (deadline.value === null) {
    return b3fail(b3err(
      'WatcherConflict', 'the drift deadline does not exist',
      { watchDeadlineId: input.watchDeadlineId }, true,
    ));
  }
  const rule = await deps.store.read<WatchRule>('watchRule', deadline.value.watchRuleId);
  if (!rule.ok) return b3fail(rule.error);
  const state = deadline.value.driftState;
  const matches = Number(deadline.value.recordVersion) === Number(input.expectedRecordVersion)
    && state?.phase === 'escalated-waiting-human'
    && state.episodeId === input.expectedEpisodeId
    && rule.value?.condition.kind === 'activity-drift';
  if (!matches) {
    return b3fail(b3err(
      'WatcherConflict', 'the reset fence does not match the escalated drift episode',
      {
        watchDeadlineId: input.watchDeadlineId,
        expectedRecordVersion: input.expectedRecordVersion,
        actualRecordVersion: deadline.value.recordVersion,
        expectedEpisodeId: input.expectedEpisodeId,
        actualEpisodeId: state?.episodeId,
        actualPhase: state?.phase,
      },
      true,
    ));
  }
  if (context.principal.kind !== 'human') {
    return b3fail(b3err(
      'PermissionDenied', 'only an authenticated human may reset a drift episode',
      { operation: 'resetDriftEpisode' }, false,
    ));
  }
  if (input.reason.trim() === '') {
    return b3fail(b3err(
      'ValidationFailed', 'reset reason must be non-empty',
      { issues: [{ path: 'reason', message: 'must be non-empty' }] }, false,
    ));
  }
  const next: DurableDriftState = {
    kind: 'activity-drift',
    episodeOrdinal: state.episodeOrdinal,
    phase: 'observing',
    quietIntervals: 0,
    consecutiveUnansweredChecks: 0,
    ...(state.lastEvidence === undefined ? {} : { lastEvidence: state.lastEvidence }),
  };
  if (rule.value === null || rule.value.condition.kind !== 'activity-drift') {
    throw new TypeError('validated drift reset lost its activity-drift rule');
  }
  const dueAt = new Date(
    deps.clock().getTime() + rule.value.condition.intervalMs,
  ).toISOString();
  return deps.store.update<WatchDeadline>(
    SUPERVISION_RECORD_WRITER,
    deadline.value.id,
    { state: 'armed', dueAt, driftState: next },
    deadline.value.recordVersion,
    context.clientOpId,
  );
}

/** Claim a bounded, deterministic scheduler page before evaluating any effect. */
export async function claimDueDeadlines(
  deps: DeadlineDependencies,
  _context: SystemCommandContext<'sys_supervision'>,
  input: ClaimDueDeadlinesInput,
): Promise<B3Result<readonly WatchDeadline[]>> {
  const armed = await deps.store.list<WatchDeadline>('watchDeadline', { state: 'armed' });
  if (!armed.ok) return b3fail(armed.error);
  const dueDeadlines = armed.value
    .filter((deadline) => String(deadline.dueAt) <= String(input.dueBefore))
    .sort((left, right) =>
      String(left.dueAt).localeCompare(String(right.dueAt))
      || String(left.id).localeCompare(String(right.id)))
    .slice(0, input.limit);
  const claimed: WatchDeadline[] = [];
  let invariantBreach: ReturnType<typeof b3err> | undefined;
  const receiptId = commandReceiptId(
    _context.principal.id,
    'supervision.claimDueDeadlines' as PublicOperationName,
    _context.clientOpId,
  );
  for (const deadline of dueDeadlines) {
    const rule = await deps.store.read<WatchRule>('watchRule', deadline.watchRuleId);
    if (!rule.ok) return rule;
    const ordinary = rule.value?.condition.kind !== 'activity-drift';
    if (ordinary
      && (deadline.creationRecordVersion === undefined
        || deadline.armingOrdinal === undefined)) {
      invariantBreach ??= b3err(
        'RecoveryRequired',
        `ordinary deadline ${String(deadline.id)} is missing immutable arming identity fields`,
        {
          operationId: receiptId,
          reason: `WatchDeadline ${String(deadline.id)} is missing `
            + `${deadline.creationRecordVersion === undefined ? 'creationRecordVersion' : 'armingOrdinal'}`,
        },
        true,
      );
      continue;
    }
    const written = await claimDeadline(deps, deadline);
    if (!written.ok) return b3fail(written.error);
    claimed.push(written.value);
    if (ordinary) {
      const progress = await startDeadlineEvaluation(
        deps.store,
        SUPERVISION_RECORD_WRITER,
        {
          commandReceiptId: receiptId,
          deadline: written.value as WatchDeadline & {
            readonly creationRecordVersion: NonNullable<WatchDeadline['creationRecordVersion']>;
          },
        },
      );
      if (!progress.ok) return progress;
    }
  }
  return invariantBreach === undefined ? b3ok(claimed) : b3fail(invariantBreach);
}
