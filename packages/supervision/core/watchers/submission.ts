// LANE B — record Runtime's outcome for one already-claimed drift status turn.
//
// Supervision remains the sole writer of both records. Runtime supplies facts;
// an injected authority resolves the Terminal attempt before either record is
// advanced. No provider effect is reachable from this module.
import {
  b3err,
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
import type { SupervisionStore } from '../store.js';

export interface DriftSubmissionAuthority {
  verify(input: RecordDriftStatusSubmissionInput): Promise<B3Result<null>>;
}

export interface DriftSubmissionDependencies {
  readonly store: SupervisionStore;
  readonly authority: DriftSubmissionAuthority;
}

type RuntimeContext = SystemCommandContext<'sys_agent_runtime'>;

const conflict = (
  message: string,
  details: Readonly<Record<string, unknown>>,
) => b3err('WatcherConflict', message, details, true);

function sameSubmission(
  deadline: WatchDeadline,
  input: RecordDriftStatusSubmissionInput,
): boolean {
  const state = deadline.driftState;
  if (state?.phase === 'observing' && state.lastClosedStatus !== undefined) {
    const closed = state.lastClosedStatus;
    return closed.episodeId === input.expectedEpisodeId
      && closed.effectKey === input.expectedEffectKey
      && closed.notificationId === input.expectedNotificationId;
  }
  if (state?.phase !== 'status-outstanding') return false;
  const outstanding = state.outstandingStatus;
  if (outstanding.state !== input.submission.state) return false;
  return outstanding.episodeId === input.expectedEpisodeId
    && outstanding.effectKey === input.expectedEffectKey
    && outstanding.notificationId === input.expectedNotificationId
    && outstanding.notificationInputReservationId
      === input.expectedNotificationInputReservationId
    && outstanding.terminalInputAttemptId === input.expectedTerminalInputAttemptId
    && outstanding.submittedAt === input.submission.submittedAt
    && outstanding.providerTurnId === input.submission.providerTurnId;
}

async function loadClaim(
  deps: DriftSubmissionDependencies,
  input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<{
  readonly deadline: WatchDeadline;
  readonly rule: WatchRule;
  readonly notification: Notification;
}>> {
  const deadline = await deps.store.read<WatchDeadline>('watchDeadline', input.watchDeadlineId);
  if (!deadline.ok) return b3fail(deadline.error);
  if (deadline.value === null) {
    return b3fail(conflict('the drift deadline does not exist', {
      watchDeadlineId: input.watchDeadlineId,
    }));
  }
  if (sameSubmission(deadline.value, input)) {
    const [rule, notification] = await Promise.all([
      deps.store.read<WatchRule>('watchRule', deadline.value.watchRuleId),
      deps.store.read<Notification>('notification', input.expectedNotificationId),
    ]);
    if (!rule.ok) return b3fail(rule.error);
    if (!notification.ok) return b3fail(notification.error);
    if (rule.value !== null && notification.value !== null
      && notificationAlreadyRecorded(notification.value, input)) {
      return b3ok({ deadline: deadline.value, rule: rule.value, notification: notification.value });
    }
  }
  const state = deadline.value.driftState;
  const outstanding = state?.phase === 'status-outstanding' ? state.outstandingStatus : undefined;
  const matches = Number(deadline.value.recordVersion) === Number(input.expectedRecordVersion)
    && outstanding?.state === 'delivery-claimed'
    && state?.episodeId === input.expectedEpisodeId
    && outstanding.effectKey === input.expectedEffectKey
    && outstanding.notificationId === input.expectedNotificationId
    && outstanding.notificationInputReservationId
      === input.expectedNotificationInputReservationId;
  if (!matches) {
    return b3fail(conflict('the claimed drift status tuple does not match current truth', {
      watchDeadlineId: input.watchDeadlineId,
      expectedRecordVersion: input.expectedRecordVersion,
      actualRecordVersion: deadline.value.recordVersion,
      expectedEpisodeId: input.expectedEpisodeId,
      actualEpisodeId: state?.episodeId,
      actualDeliveryState: outstanding?.state,
    }));
  }
  const [rule, notification] = await Promise.all([
    deps.store.read<WatchRule>('watchRule', deadline.value.watchRuleId),
    deps.store.read<Notification>('notification', input.expectedNotificationId),
  ]);
  if (!rule.ok) return b3fail(rule.error);
  if (!notification.ok) return b3fail(notification.error);
  if (rule.value === null || rule.value.condition.kind !== 'activity-drift'
    || rule.value.driftPolicy === undefined || notification.value === null) {
    return b3fail(conflict('the drift submission dependencies are missing or incompatible', {
      watchRuleId: deadline.value.watchRuleId,
      notificationId: input.expectedNotificationId,
    }));
  }
  return b3ok({ deadline: deadline.value, rule: rule.value, notification: notification.value });
}

function notificationAlreadyRecorded(
  notification: Notification,
  input: RecordDriftStatusSubmissionInput,
): boolean {
  const attempt = notification.deliveryAttempt;
  return attempt.state === input.submission.state
    && attempt.effectKey === input.expectedEffectKey
    && attempt.notificationInputReservationId === input.expectedNotificationInputReservationId
    && attempt.terminalInputAttemptId === input.expectedTerminalInputAttemptId
    && attempt.submittedAt === input.submission.submittedAt
    && attempt.providerTurnId === input.submission.providerTurnId;
}

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
  const state = current.value.deadline.driftState!;
  if (state.phase !== 'status-outstanding'
    || state.outstandingStatus.state !== 'delivery-claimed') {
    return b3fail(conflict('the drift status is not claimed', {
      watchDeadlineId: current.value.deadline.id,
    }));
  }
  const submittedAtMs = Date.parse(input.submission.submittedAt);
  if (submittedAtMs < Date.parse(state.outstandingStatus.requestedAt)) {
    return b3fail(conflict('submittedAt precedes the durable request', {
      requestedAt: state.outstandingStatus.requestedAt,
      submittedAt: input.submission.submittedAt,
    }));
  }
  const replyDueAt = new Date(
    submittedAtMs + current.value.rule.driftPolicy!.replyWindowMs,
  ).toISOString() as IsoUtc;
  const notification = await persistNotificationOutcome(
    deps, current.value.notification, input,
  );
  if (!notification.ok) return b3fail(notification.error);
  const closed = closedAfterPendingMovement(state, input);
  const dueAt = closed === null
    ? replyDueAt
    : new Date(
      submittedAtMs + (
        current.value.rule.condition.kind === 'activity-drift'
          ? current.value.rule.condition.intervalMs
          : 0
      ),
    ).toISOString() as IsoUtc;
  return deps.store.update<WatchDeadline>(
    SUPERVISION_RECORD_WRITER,
    current.value.deadline.id,
    {
      dueAt,
      state: 'armed',
      driftState: closed ?? submittedState(state, input, replyDueAt),
    },
    current.value.deadline.recordVersion,
    deriveClientOpId(
      'b3v4:record-drift-status-submission:'
        + current.value.deadline.id + ':' + input.expectedTerminalInputAttemptId,
    ),
  );
}
