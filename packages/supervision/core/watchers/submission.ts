// LANE B — record Runtime's outcome for one already-claimed drift status turn.
//
// Supervision remains the sole writer of both records. Runtime supplies facts;
// an injected authority resolves the Terminal attempt before either record is
// advanced. No provider effect is reachable from this module.
import {
  b3fail,
  b3ok,
  deriveClientOpId,
  type B3Result,
  type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  SUPERVISION_RECORD_WRITER,
  type ClosedDriftStatus,
  type DurableDriftState,
  type Notification,
  type RecordDriftStatusSubmissionInput,
  type WatchDeadline,
  type WatchRule,
} from '../../contract/index.js';
import {
  driftSubmissionConflict as conflict,
  loadClaim,
  notificationAlreadyRecorded,
  sameSubmission,
  type DriftSubmissionDependencies,
} from './submission-load.js';

export type {
  DriftSubmissionAuthority,
  DriftSubmissionDependencies,
} from './submission-load.js';

type RuntimeContext = SystemCommandContext<'sys_agent_runtime'>;

async function persistNotificationOutcome(
  deps: DriftSubmissionDependencies,
  notification: Notification,
  input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<Notification>> {
  if (notificationAlreadyRecorded(notification, input)) return b3ok(notification);
  const attempt = notification.deliveryAttempt;
  const matches = attempt.state === 'delivery-claimed'
    && attempt.effectKey === input.expectedEffectKey
    && attempt.notificationInputReservationId === input.expectedNotificationInputReservationId;
  if (!matches) {
    return b3fail(conflict('the Notification claim does not match the drift submission', {
      notificationId: notification.id,
      deliveryState: attempt.state,
    }));
  }
  return deps.store.update<Notification>(
    SUPERVISION_RECORD_WRITER,
    notification.id,
    {
      state: input.submission.state === 'submitted-confirmed'
        ? 'offered-to-endpoint'
        : 'delivery-uncertain',
      deliveryAttempt: {
        state: input.submission.state,
        effectKey: input.expectedEffectKey,
        submittedAt: input.submission.submittedAt,
        notificationInputReservationId: input.expectedNotificationInputReservationId,
        terminalInputAttemptId: input.expectedTerminalInputAttemptId,
        ...(input.submission.providerTurnId === undefined
          ? {}
          : { providerTurnId: input.submission.providerTurnId }),
      },
    },
    notification.recordVersion,
    deriveClientOpId(
      'b3v4:record-drift-notification-submission:'
        + notification.id + ':' + input.expectedTerminalInputAttemptId,
    ),
  );
}

function submittedState(
  current: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  input: RecordDriftStatusSubmissionInput,
  replyDueAt: IsoUtc,
): DurableDriftState {
  const claimed = current.outstandingStatus;
  if (claimed.state !== 'delivery-claimed') {
    throw new TypeError('submission reducer received a non-claimed status');
  }
  return {
    ...current,
    outstandingStatus: {
      episodeId: claimed.episodeId,
      effectKey: claimed.effectKey,
      notificationId: claimed.notificationId,
      requestedAt: claimed.requestedAt,
      state: input.submission.state,
      submittedAt: input.submission.submittedAt,
      replyDueAt,
      notificationInputReservationId: input.expectedNotificationInputReservationId,
      terminalInputAttemptId: input.expectedTerminalInputAttemptId,
      ...(input.submission.providerTurnId === undefined
        ? {}
        : { providerTurnId: input.submission.providerTurnId }),
    },
  } as DurableDriftState;
}

function closedAfterPendingMovement(
  current: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  input: RecordDriftStatusSubmissionInput,
): DurableDriftState | null {
  const claimed = current.outstandingStatus;
  if (claimed.state !== 'delivery-claimed'
    || claimed.pendingMovementEvidenceRef === undefined) return null;
  const closed: ClosedDriftStatus = {
    episodeId: claimed.episodeId,
    effectKey: claimed.effectKey,
    notificationId: claimed.notificationId,
    state: 'activity-observed-after-submission',
    closedAt: input.submission.submittedAt,
    closureEvidenceRef: claimed.pendingMovementEvidenceRef,
  };
  return {
    kind: 'activity-drift',
    episodeOrdinal: current.episodeOrdinal,
    phase: 'observing',
    quietIntervals: 0,
    consecutiveUnansweredChecks: 0,
    ...(current.lastEvidence === undefined ? {} : { lastEvidence: current.lastEvidence }),
    lastClosedStatus: closed,
  };
}

interface ClaimedSubmission {
  readonly state: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>;
  readonly submittedAtMs: number;
  readonly replyDueAt: IsoUtc;
}

function claimedSubmission(
  deadline: WatchDeadline,
  rule: WatchRule,
  input: RecordDriftStatusSubmissionInput,
): B3Result<ClaimedSubmission> {
  const state = deadline.driftState;
  if (state?.phase !== 'status-outstanding'
    || state.outstandingStatus.state !== 'delivery-claimed') {
    return b3fail(conflict('the drift status is not claimed', {
      watchDeadlineId: deadline.id,
    }));
  }
  const submittedAtMs = Date.parse(input.submission.submittedAt);
  if (submittedAtMs < Date.parse(state.outstandingStatus.requestedAt)) {
    return b3fail(conflict('submittedAt precedes the durable request', {
      requestedAt: state.outstandingStatus.requestedAt,
      submittedAt: input.submission.submittedAt,
    }));
  }
  if (rule.driftPolicy === undefined) {
    throw new TypeError('validated drift submission lost its durable policy');
  }
  return b3ok({
    state,
    submittedAtMs,
    replyDueAt: new Date(
      submittedAtMs + rule.driftPolicy.replyWindowMs,
    ).toISOString() as IsoUtc,
  });
}

function nextDeadlineDueAt(
  closed: DurableDriftState | null,
  rule: WatchRule,
  submittedAtMs: number,
  replyDueAt: IsoUtc,
): IsoUtc {
  if (closed === null) return replyDueAt;
  if (rule.condition.kind !== 'activity-drift') {
    throw new TypeError('validated drift submission lost its activity-drift rule');
  }
  return new Date(submittedAtMs + rule.condition.intervalMs).toISOString() as IsoUtc;
}

/** Q2's complete Runtime→Supervision CAS, with no provider effect. */
export async function recordDriftStatusSubmission(
  deps: DriftSubmissionDependencies,
  _context: RuntimeContext,
  input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<WatchDeadline>> {
  const current = await loadClaim(deps, input);
  if (!current.ok) return b3fail(current.error);
  if (sameSubmission(current.value.deadline, input)) return b3ok(current.value.deadline);
  const verified = await deps.authority.verify(input);
  if (!verified.ok) return b3fail(verified.error);
  const submission = claimedSubmission(
    current.value.deadline, current.value.rule, input,
  );
  if (!submission.ok) return b3fail(submission.error);
  const notification = await persistNotificationOutcome(
    deps, current.value.notification, input,
  );
  if (!notification.ok) return b3fail(notification.error);
  const closed = closedAfterPendingMovement(submission.value.state, input);
  const dueAt = nextDeadlineDueAt(
    closed,
    current.value.rule,
    submission.value.submittedAtMs,
    submission.value.replyDueAt,
  );
  return deps.store.update<WatchDeadline>(
    SUPERVISION_RECORD_WRITER,
    current.value.deadline.id,
    {
      dueAt,
      state: 'armed',
      driftState: closed ?? submittedState(
        submission.value.state, input, submission.value.replyDueAt,
      ),
    },
    current.value.deadline.recordVersion,
    deriveClientOpId(
      'b3v4:record-drift-status-submission:'
        + current.value.deadline.id + ':' + input.expectedTerminalInputAttemptId,
    ),
  );
}
