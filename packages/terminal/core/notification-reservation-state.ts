// Terminal-owned lookup and settlement for one Notification input reservation.
import {
  b3err, b3fail, b3ok, mintClientOpId,
  type B3Result, type NotificationInputReservationId,
  type TerminalInputAttemptId, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  NotificationInputReservation, TerminalInputAttempt,
} from '../contract/records.js';
import { clockIso, type TerminalCore } from './context.js';

export type NotificationAttempt = Extract<
  TerminalInputAttempt, { readonly source: 'system-notification' }
>;
export type ReservedNotificationInput = Extract<
  NotificationInputReservation, { readonly state: 'reserved' }
>;
export type CommittedNotificationInput = Extract<
  NotificationInputReservation, { readonly state: 'committed' }
>;

export async function activeNotificationReservation(
  core: TerminalCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<NotificationInputReservation | null>> {
  const listed = await core.store.list<NotificationInputReservation>(
    'notificationInputReservation', { terminalSessionId },
  );
  if (!listed.ok) return listed;
  const active = listed.value.filter((item) => item.state === 'reserved');
  if (active.length > 1) {
    return b3fail(b3err(
      'RecoveryRequired', 'more than one notification input reservation fences this session',
      { terminalSessionId, reservationIds: active.map((item) => item.id) }, true,
    ));
  }
  return b3ok(active[0] ?? null);
}

export async function notificationAttemptFor(
  core: TerminalCore, reservationId: NotificationInputReservationId,
): Promise<B3Result<NotificationAttempt | null>> {
  const attempts = await core.store.list<TerminalInputAttempt>(
    'terminalInputAttempt', { notificationInputReservationId: reservationId },
  );
  if (!attempts.ok) return attempts;
  const systemAttempts = attempts.value.filter(
    (attempt): attempt is NotificationAttempt => attempt.source === 'system-notification',
  );
  if (systemAttempts.length > 1) {
    return b3fail(b3err('RecoveryRequired',
      'one notification reservation has more than one Terminal attempt', {
        notificationInputReservationId: reservationId,
        terminalInputAttemptIds: systemAttempts.map((attempt) => attempt.id),
      }, true));
  }
  return b3ok(systemAttempts[0] ?? null);
}

export async function finishNotificationReservation(
  core: TerminalCore,
  reservation: ReservedNotificationInput,
  terminalInputAttemptId: TerminalInputAttemptId,
): Promise<B3Result<CommittedNotificationInput>> {
  const written = await core.store.update<NotificationInputReservation>(
    'sys_terminal', 'notificationInputReservation', reservation.id,
    { state: 'committed', terminalInputAttemptId, endedAt: clockIso(core) },
    reservation.recordVersion, mintClientOpId(),
  );
  return written as B3Result<CommittedNotificationInput>;
}
