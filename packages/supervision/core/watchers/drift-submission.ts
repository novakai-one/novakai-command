// Runtime's Terminal-observed outcome for one already-claimed drift request.
//
// Supervision remains the sole writer of both records. The Notification half
// lands first; replay then adopts it and finishes the WatchDeadline CAS. That
// ordering makes every crash state recoverable without repeating provider IO.
import {
  b3err, b3fail, b3ok, deriveClientOpId,
  type B3Result, type IsoUtc, type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  SUPERVISION_RECORD_WRITER,
  type ClosedDriftStatus, type DurableDriftState, type Notification,
  type RecordDriftStatusSubmissionInput, type WatchDeadline, type WatchRule,
} from '../../contract/index.js';
import type { SupervisionStore } from '../store.js';

export interface DriftSubmissionAuthority {
  verify(input: RecordDriftStatusSubmissionInput): Promise<B3Result<null>>;
}

export interface DriftSubmissionDependencies {
  readonly store: SupervisionStore;
  readonly authority: DriftSubmissionAuthority;
}

type Outstanding = Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>;

const conflict = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3err('WatcherConflict', message, details, true);

interface SubmissionRecords {
  readonly deadline: WatchDeadline;
  readonly notification: Notification;
}

async function loadSubmissionRecords(
  store: SupervisionStore, input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<SubmissionRecords>> {
  const [deadlineRead, notificationRead] = await Promise.all([
    store.read<WatchDeadline>('watchDeadline', input.watchDeadlineId),
    store.read<Notification>('notification', input.expectedNotificationId),
  ]);
  if (!deadlineRead.ok) return deadlineRead;
  if (!notificationRead.ok) return notificationRead;
  if (deadlineRead.value === null || notificationRead.value === null) {
    return b3fail(conflict('the drift submission records do not exist', {
      watchDeadlineId: input.watchDeadlineId,
      notificationId: input.expectedNotificationId,
    }));
  }
  return b3ok({ deadline: deadlineRead.value, notification: notificationRead.value });
}

interface DriftTiming {
  readonly intervalMs: number;
  readonly replyWindowMs: number;
}

async function loadDriftTiming(
  store: SupervisionStore, deadline: WatchDeadline,
): Promise<B3Result<DriftTiming>> {
  const ruleRead = await store.read<WatchRule>('watchRule', deadline.watchRuleId);
  if (!ruleRead.ok) return ruleRead;
  const rule = ruleRead.value;
  if (rule === null || rule.condition.kind !== 'activity-drift'
    || rule.driftPolicy === undefined) {
    return b3fail(conflict('the drift submission has no compatible WatchRule', {
      watchRuleId: deadline.watchRuleId,
    }));
  }
  return b3ok({
    intervalMs: rule.condition.intervalMs,
    replyWindowMs: rule.driftPolicy.replyWindowMs,
  });
}

function parseSubmittedAt(
  deadline: WatchDeadline & { readonly driftState: Outstanding },
  input: RecordDriftStatusSubmissionInput,
): B3Result<number> {
  const submittedAtMs = Date.parse(input.submission.submittedAt);
  if (!Number.isFinite(submittedAtMs)
    || submittedAtMs < Date.parse(deadline.driftState.outstandingStatus.requestedAt)) {
    return b3fail(conflict('submittedAt precedes the durable request', {
      submittedAt: input.submission.submittedAt,
    }));
  }
  return b3ok(submittedAtMs);
}

function sameSubmission(
  deadline: WatchDeadline, input: RecordDriftStatusSubmissionInput,
): boolean {
  const drift = deadline.driftState;
  if (drift?.phase === 'observing' && drift.lastClosedStatus !== undefined) {
    return drift.lastClosedStatus.episodeId === input.expectedEpisodeId
      && drift.lastClosedStatus.effectKey === input.expectedEffectKey
      && drift.lastClosedStatus.notificationId === input.expectedNotificationId;
  }
  if (drift?.phase !== 'status-outstanding') return false;
  const status = drift.outstandingStatus;
  return status.state === input.submission.state
    && status.episodeId === input.expectedEpisodeId
    && status.effectKey === input.expectedEffectKey
    && status.notificationId === input.expectedNotificationId
    && status.notificationInputReservationId
      === input.expectedNotificationInputReservationId
    && status.terminalInputAttemptId === input.expectedTerminalInputAttemptId
    && status.submittedAt === input.submission.submittedAt
    && status.providerTurnId === input.submission.providerTurnId;
}

function notificationRecorded(
  notification: Notification, input: RecordDriftStatusSubmissionInput,
): boolean {
  const attempt = notification.deliveryAttempt;
  return attempt.state === input.submission.state
    && attempt.effectKey === input.expectedEffectKey
    && attempt.notificationInputReservationId === input.expectedNotificationInputReservationId
    && attempt.terminalInputAttemptId === input.expectedTerminalInputAttemptId
    && attempt.submittedAt === input.submission.submittedAt
    && attempt.providerTurnId === input.submission.providerTurnId;
}

function submissionAlreadyComplete(
  records: SubmissionRecords, input: RecordDriftStatusSubmissionInput,
): boolean {
  return sameSubmission(records.deadline, input)
    && notificationRecorded(records.notification, input);
}

function claimMatches(
  deadline: WatchDeadline, input: RecordDriftStatusSubmissionInput,
): deadline is WatchDeadline & { readonly driftState: Outstanding } {
  const drift = deadline.driftState;
  const status = drift?.phase === 'status-outstanding' ? drift.outstandingStatus : undefined;
  return Number(deadline.recordVersion) === Number(input.expectedRecordVersion)
    && drift?.phase === 'status-outstanding'
    && drift.episodeId === input.expectedEpisodeId
    && status?.state === 'delivery-claimed'
    && status.effectKey === input.expectedEffectKey
    && status.notificationId === input.expectedNotificationId
    && status.notificationInputReservationId
      === input.expectedNotificationInputReservationId;
}

async function persistNotification(
  store: SupervisionStore,
  notification: Notification,
  input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<Notification>> {
  if (notificationRecorded(notification, input)) return b3ok(notification);
  const attempt = notification.deliveryAttempt;
  if (attempt.state !== 'delivery-claimed'
    || attempt.effectKey !== input.expectedEffectKey
    || attempt.notificationInputReservationId
      !== input.expectedNotificationInputReservationId) {
    return b3fail(conflict('the Notification claim does not match the drift submission', {
      notificationId: notification.id, deliveryState: attempt.state,
    }));
  }
  return store.update<Notification>(
    SUPERVISION_RECORD_WRITER,
    notification.id,
    {
      state: input.submission.state === 'submitted-confirmed'
        ? 'offered-to-endpoint' : 'delivery-uncertain',
      deliveryAttempt: {
        state: input.submission.state,
        effectKey: input.expectedEffectKey,
        submittedAt: input.submission.submittedAt,
        notificationInputReservationId: input.expectedNotificationInputReservationId,
        terminalInputAttemptId: input.expectedTerminalInputAttemptId,
        ...(input.submission.providerTurnId === undefined
          ? {} : { providerTurnId: input.submission.providerTurnId }),
      },
    },
    notification.recordVersion,
    deriveClientOpId(
      `b3v4:record-drift-notification-submission:${notification.id}:`
        + input.expectedTerminalInputAttemptId,
    ),
  );
}

function submittedState(
  current: Outstanding,
  input: RecordDriftStatusSubmissionInput,
  replyDueAt: IsoUtc,
): DurableDriftState {
  const claimed = current.outstandingStatus;
  if (claimed.state !== 'delivery-claimed') return current;
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
        ? {} : { providerTurnId: input.submission.providerTurnId }),
    },
  } as DurableDriftState;
}

function closedAfterPendingMovement(
  current: Outstanding, input: RecordDriftStatusSubmissionInput,
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

export async function recordDriftStatusSubmission(
  deps: DriftSubmissionDependencies,
  _context: SystemCommandContext<'sys_agent_runtime'>,
  input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<WatchDeadline>> {
  const records = await loadSubmissionRecords(deps.store, input);
  if (!records.ok) return records;
  const { deadline, notification: currentNotification } = records.value;
  if (submissionAlreadyComplete(records.value, input)) {
    return b3ok(deadline);
  }
  if (!claimMatches(deadline, input)) {
    return b3fail(conflict('the claimed drift status tuple does not match current truth', {
      watchDeadlineId: input.watchDeadlineId,
      expectedRecordVersion: input.expectedRecordVersion,
      actualRecordVersion: deadline.recordVersion,
      actualDeliveryState: deadline.driftState?.phase === 'status-outstanding'
        ? deadline.driftState.outstandingStatus.state : undefined,
    }));
  }
  const timing = await loadDriftTiming(deps.store, deadline);
  if (!timing.ok) return timing;
  const submittedAt = parseSubmittedAt(deadline, input);
  if (!submittedAt.ok) return submittedAt;
  const verified = await deps.authority.verify(input);
  if (!verified.ok) return verified;
  const persisted = await persistNotification(
    deps.store, currentNotification, input,
  );
  if (!persisted.ok) return persisted;

  const closed = closedAfterPendingMovement(deadline.driftState, input);
  const replyDueAt = new Date(
    submittedAt.value + timing.value.replyWindowMs,
  ).toISOString() as IsoUtc;
  const dueAt = closed === null
    ? replyDueAt
    : new Date(submittedAt.value + timing.value.intervalMs).toISOString() as IsoUtc;
  return deps.store.update<WatchDeadline>(
    SUPERVISION_RECORD_WRITER,
    deadline.id,
    {
      dueAt,
      state: 'armed',
      driftState: closed ?? submittedState(
        deadline.driftState, input, replyDueAt,
      ),
    },
    deadline.recordVersion,
    deriveClientOpId(
      `b3v4:record-drift-status-submission:${deadline.id}:`
        + input.expectedTerminalInputAttemptId,
    ),
  );
}
