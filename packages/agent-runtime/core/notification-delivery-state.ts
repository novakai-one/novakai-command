// Durable owner-reconciled query for one delivery operation.
import {
  b3err, b3fail, b3ok, notificationInputReservationId,
  type AuthenticatedPrincipal, type B3Result, type NotificationId,
  type NotificationInputReservationId,
} from '@novakai/foundation/contract';
import type { NotificationTurnSubmission } from '../contract/notification-delivery.js';
import type { ProviderTurnSubmission } from '../contract/provider-turns.js';
import type { NotificationInputAttemptFacts } from '../contract/ports.js';
import type { RunOperation } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';

type Submitted = Extract<
  NotificationTurnSubmission,
  { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
>;

const reader: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};

/** The one semantic submission correlated to a Notification effect. */
export async function semanticNotificationSubmission(
  core: RunsCore,
  effectKey: string,
): Promise<B3Result<ProviderTurnSubmission | null>> {
  const listed = await core.store.list<ProviderTurnSubmission>('providerTurnSubmission');
  if (!listed.ok) return listed;
  const correlated = listed.value.filter((submission) =>
    submission.submissionEffectKey === effectKey
    && submission.origin.kind === 'runtime-effect'
    && (submission.origin.source === 'watcher-status-request'
      || submission.origin.source === 'notification-start-turn'));
  if (correlated.length > 1) {
    return b3fail(b3err(
      'RecoveryRequired', 'one Notification effect has multiple provider-turn submissions',
      { effectKey, providerTurnSubmissionIds: correlated.map((item) => item.id).sort() }, true,
    ));
  }
  return b3ok(correlated[0] ?? null);
}

export async function notificationOperationFor(
  core: RunsCore, effectKey: string,
): Promise<B3Result<RunOperation | null>> {
  const listed = await core.store.list<RunOperation>('runOperation');
  if (!listed.ok) return listed;
  const matching = listed.value.filter((operation) =>
    operation.kindOfOperation === 'deliver-notification'
      && operation.notificationDeliveryEffectKey === effectKey);
  if (matching.length > 1) {
    return b3fail(b3err(
      'RecoveryRequired', 'one Notification effect has more than one Runtime operation',
      { effectKey, operationIds: matching.map((operation) => operation.id) }, true,
    ));
  }
  return b3ok(matching[0] ?? null);
}

export function submittedOutcome(attempt: NotificationInputAttemptFacts): Submitted {
  return attempt.outcome === 'submitted-confirmed'
    ? {
        state: 'submitted-confirmed',
        submittedAt: attempt.submittedAt,
        providerTurnId: attempt.providerTurnId,
      }
    : {
        state: 'submitted-unconfirmed',
        submittedAt: attempt.submittedAt,
        providerTurnId: attempt.providerTurnId,
      };
}

function notificationOf(operation: RunOperation): B3Result<NotificationId> {
  return operation.notificationId === undefined
    ? b3fail(b3err(
        'RecoveryRequired', 'a delivery operation names no Notification',
        { operationId: operation.id }, true,
      ))
    : b3ok(operation.notificationId);
}

async function reservedState(
  core: RunsCore,
  operation: RunOperation,
  reservationId: NotificationInputReservationId,
  effectKey: string,
): Promise<B3Result<NotificationTurnSubmission>> {
  if (core.notifications === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'Supervision notification delivery is not composed',
      { reason: 'notification-delivery-not-composed' }, true,
    ));
  }
  const notification = notificationOf(operation);
  if (!notification.ok) return notification;
  const ownerState = await core.notifications.getDeliveryState(reader, {
    notificationId: notification.value,
    effectKey,
    notificationInputReservationId: reservationId,
  });
  if (!ownerState.ok) return ownerState;
  if (ownerState.value.state === 'submitted-confirmed'
    || ownerState.value.state === 'submitted-unconfirmed') {
    return b3fail(b3err(
      'RecoveryRequired', 'Supervision records submission before Terminal committed it',
      { notificationId: notification.value, effectKey }, true,
    ));
  }
  if (ownerState.value.state === 'delivery-claimed') {
    return b3ok({
      state: 'claimed-pending-submission',
      notificationInputReservationId: reservationId,
      notificationId: notification.value,
    });
  }
  return b3ok({ state: 'reserved-not-claimed', notificationInputReservationId: reservationId });
}

async function committedState(
  core: RunsCore,
  reservationId: NotificationInputReservationId,
  attemptId: Parameters<RunsCore['terminal']['getNotificationInputAttempt']>[0] | undefined,
): Promise<B3Result<NotificationTurnSubmission>> {
  if (attemptId === undefined) {
    return b3fail(b3err(
      'RecoveryRequired', 'a committed Notification reservation names no Terminal attempt',
      { notificationInputReservationId: reservationId }, true,
    ));
  }
  const attempt = await core.terminal.getNotificationInputAttempt(attemptId);
  if (!attempt.ok) return attempt;
  if (attempt.value === null) {
    return b3fail(b3err(
      'RecoveryRequired', 'a committed Notification reservation lost its Terminal attempt',
      { notificationInputReservationId: reservationId, terminalInputAttemptId: attemptId }, true,
    ));
  }
  return b3ok(submittedOutcome(attempt.value));
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Exhaustive durable delivery-state reducer.
export async function getNotificationTurnSubmission(
  core: RunsCore, effectKey: string,
): Promise<B3Result<NotificationTurnSubmission>> {
  const semantic = await semanticNotificationSubmission(core, effectKey);
  if (!semantic.ok) return semantic;
  const correlated = semantic.value;
  if (correlated !== null) {
    if (correlated.state.kind === 'submitted-confirmed') {
      return b3ok({
        state: 'submitted-confirmed', submittedAt: correlated.state.submittedAt,
        providerTurnId: correlated.providerTurnId,
      });
    }
    if (correlated.state.kind === 'submitted-unconfirmed') {
      return b3ok({
        state: 'submitted-unconfirmed', submittedAt: correlated.state.submittedAt,
        providerTurnId: correlated.providerTurnId,
      });
    }
    if (correlated.state.kind === 'completed') {
      return b3ok({
        state: correlated.state.submissionDisposition,
        submittedAt: correlated.state.completedAt,
        providerTurnId: correlated.providerTurnId,
      });
    }
    if (correlated.state.kind === 'rejected') {
      return b3ok({
        state: 'cancelled-not-submitted',
        notificationInputReservationId: correlated.origin.kind === 'runtime-effect'
          ? notificationInputReservationId(correlated.origin.sourceEffectKey)
          : notificationInputReservationId(effectKey),
        cancelledAt: correlated.state.rejectedAt,
      });
    }
    return b3ok({
      state: 'reserved-not-claimed',
      notificationInputReservationId: notificationInputReservationId(effectKey),
    });
  }
  const found = await notificationOperationFor(core, effectKey);
  if (!found.ok) return found;
  const operation = found.value;
  const reservationId = operation?.notificationInputReservationId;
  if (operation === null || reservationId === undefined) return b3ok({ state: 'absent' });
  const reservation = await core.terminal.getNotificationInputReservation(reservationId);
  if (!reservation.ok) return reservation;
  if (reservation.value === null) return b3ok({ state: 'absent' });
  if (reservation.value.state === 'cancelled') {
    if (reservation.value.endedAt === undefined) {
      return b3fail(b3err(
        'RecoveryRequired', 'a cancelled Notification reservation has no end time',
        { notificationInputReservationId: reservationId }, true,
      ));
    }
    return b3ok({
      state: 'cancelled-not-submitted',
      notificationInputReservationId: reservationId,
      cancelledAt: reservation.value.endedAt,
    });
  }
  if (reservation.value.state === 'reserved') {
    return reservedState(core, operation, reservationId, effectKey);
  }
  return committedState(core, reservationId, reservation.value.terminalInputAttemptId);
}
