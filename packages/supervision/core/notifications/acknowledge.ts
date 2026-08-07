// LANE C — settling a Notification.
//
// Acknowledgement is the one transition a person causes directly, so it is the
// one most tempting to make lenient. It is not: the frozen machine in
// `records.ts` says `acknowledged` is reachable only from `transcript-observed`,
// and this asks that machine rather than re-deciding it. An ack from `queued`
// would claim the recipient saw something no evidence says was delivered.
import {
  b3err, b3fail, b3ok, deriveClientOpId,
  type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import {
  SUPERVISION_RECORD_WRITER, canTransitionNotificationState,
  type Notification, type NotificationId,
} from '../../contract/index.js';
import type { DeliveryDependencies } from './delivery.js';

/**
 * Settle one observed Notification, idempotently.
 *
 * Replay returns the settled record untouched rather than a conflict: a person
 * clicking twice, or a client retrying, is not an error condition — and
 * `acknowledged` is terminal in the frozen machine, so there is nothing a
 * second write could legally change.
 */
export async function acknowledgeNotification(
  deps: DeliveryDependencies,
  _context: CommandContext,
  notificationId: NotificationId,
): Promise<B3Result<Notification>> {
  const stored = await deps.store.read<Notification>('notification', notificationId);
  if (!stored.ok) return b3fail(stored.error);
  if (stored.value === null) {
    return b3fail(b3err('ValidationFailed', 'unknown notification', { notificationId }, false));
  }
  const notification = stored.value;

  if (notification.state === 'acknowledged') return b3ok(notification);

  if (!canTransitionNotificationState(notification.state, 'acknowledged')) {
    return b3fail(b3err(
      'ValidationFailed',
      'a notification is acknowledged only once its delivery has been observed',
      { notificationId, state: notification.state },
      false,
    ));
  }

  const written = await deps.store.update<Notification>(
    SUPERVISION_RECORD_WRITER,
    notificationId,
    { state: 'acknowledged' },
    notification.recordVersion,
    deriveClientOpId(`b3v4:acknowledge-notification:${notificationId}`),
  );
  if (!written.ok) return b3fail(written.error);
  return b3ok(written.value);
}
