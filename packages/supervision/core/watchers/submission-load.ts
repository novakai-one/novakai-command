// Adopt or validate the durable claim behind one Runtime drift submission.
import {
  b3err,
  b3fail,
  b3ok,
  type B3Result,
} from '@novakai/foundation/contract';
import {
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

export interface LoadedDriftClaim {
  readonly deadline: WatchDeadline;
  readonly rule: WatchRule;
  readonly notification: Notification;
}

/** Typed conflict shared by submission claim and persistence checks. */
export const driftSubmissionConflict = (
  message: string,
  details: Readonly<Record<string, unknown>>,
) => b3err('WatcherConflict', message, details, true);

/** Whether a prior complete effect exactly matches this Runtime submission. */
export function sameSubmission(
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

/** Whether the Notification half of a submission effect is already durable. */
export function notificationAlreadyRecorded(
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

async function relatedRecords(
  deps: DriftSubmissionDependencies,
  deadline: WatchDeadline,
  input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<Pick<LoadedDriftClaim, 'rule' | 'notification'> | null>> {
  const [rule, notification] = await Promise.all([
    deps.store.read<WatchRule>('watchRule', deadline.watchRuleId),
    deps.store.read<Notification>('notification', input.expectedNotificationId),
  ]);
  if (!rule.ok) return b3fail(rule.error);
  if (!notification.ok) return b3fail(notification.error);
  if (rule.value === null || notification.value === null) return b3ok(null);
  return b3ok({ rule: rule.value, notification: notification.value });
}

async function adoptReplay(
  deps: DriftSubmissionDependencies,
  deadline: WatchDeadline,
  input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<LoadedDriftClaim | null>> {
  if (!sameSubmission(deadline, input)) return b3ok(null);
  const related = await relatedRecords(deps, deadline, input);
  if (!related.ok) return b3fail(related.error);
  if (related.value === null
    || !notificationAlreadyRecorded(related.value.notification, input)) return b3ok(null);
  return b3ok({ deadline, ...related.value });
}

function claimMatches(
  deadline: WatchDeadline,
  input: RecordDriftStatusSubmissionInput,
): boolean {
  const state = deadline.driftState;
  const outstanding = state?.phase === 'status-outstanding'
    ? state.outstandingStatus
    : undefined;
  return Number(deadline.recordVersion) === Number(input.expectedRecordVersion)
    && outstanding?.state === 'delivery-claimed'
    && state?.episodeId === input.expectedEpisodeId
    && outstanding.effectKey === input.expectedEffectKey
    && outstanding.notificationId === input.expectedNotificationId
    && outstanding.notificationInputReservationId
      === input.expectedNotificationInputReservationId;
}

function claimMismatch(
  deadline: WatchDeadline,
  input: RecordDriftStatusSubmissionInput,
): ReturnType<typeof driftSubmissionConflict> {
  const state = deadline.driftState;
  const outstanding = state?.phase === 'status-outstanding'
    ? state.outstandingStatus
    : undefined;
  return driftSubmissionConflict('the claimed drift status tuple does not match current truth', {
    watchDeadlineId: input.watchDeadlineId,
    expectedRecordVersion: input.expectedRecordVersion,
    actualRecordVersion: deadline.recordVersion,
    expectedEpisodeId: input.expectedEpisodeId,
    actualEpisodeId: state?.episodeId,
    actualDeliveryState: outstanding?.state,
  });
}

/** Load one exact claim or adopt its complete previously committed effect. */
export async function loadClaim(
  deps: DriftSubmissionDependencies,
  input: RecordDriftStatusSubmissionInput,
): Promise<B3Result<LoadedDriftClaim>> {
  const deadline = await deps.store.read<WatchDeadline>('watchDeadline', input.watchDeadlineId);
  if (!deadline.ok) return b3fail(deadline.error);
  if (deadline.value === null) {
    return b3fail(driftSubmissionConflict('the drift deadline does not exist', {
      watchDeadlineId: input.watchDeadlineId,
    }));
  }
  const replay = await adoptReplay(deps, deadline.value, input);
  if (!replay.ok) return b3fail(replay.error);
  if (replay.value !== null) return b3ok(replay.value);
  if (!claimMatches(deadline.value, input)) {
    return b3fail(claimMismatch(deadline.value, input));
  }
  const related = await relatedRecords(deps, deadline.value, input);
  if (!related.ok) return b3fail(related.error);
  if (related.value === null
    || related.value.rule.condition.kind !== 'activity-drift'
    || related.value.rule.driftPolicy === undefined) {
    return b3fail(driftSubmissionConflict(
      'the drift submission dependencies are missing or incompatible',
      {
        watchRuleId: deadline.value.watchRuleId,
        notificationId: input.expectedNotificationId,
      },
    ));
  }
  return b3ok({ deadline: deadline.value, ...related.value });
}
