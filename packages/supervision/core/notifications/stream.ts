// LANE C — Q8's notification stream, which is a bounded page and not a socket.
//
// The freeze pins `SUPERVISION_NOTIFICATION_SUBSCRIBE_METHOD` onto the EXISTING
// v1 request/response frame: a subscriber asks for a page and asks again from
// the cursor it was given. Stopping asking IS cancellation, so there is no
// server-held subscription to leak on a dropped socket, and no unbounded push.
//
// The page is a projection over the durable records rather than a second log:
// a Notification's committed state is the only truth, and an event that could
// disagree with it would be a second store wearing a different name.
import {
  b3fail, b3ok, mintTraceCorrelationId,
  type B3Result, type EventCursor, type TraceCorrelationId,
} from '@novakai/foundation/contract';
import type {
  Notification, NotificationEvent, NotificationEventPage, NotificationEventPageInput,
} from '../../contract/index.js';
import type { DeliveryDependencies } from './delivery.js';

/** Stable total order: creation time, then identity to break exact ties. */
function positionOf(notification: Notification): string {
  return `${String(notification.createdAt)}|${String(notification.id)}`;
}

/**
 * The cursor is opaque BECAUSE it is encoded, not merely by convention. A raw
 * `createdAt|id` position is not URL-safe, and a caller that could read it
 * would start constructing one.
 */
const cursorOf = (notification: Notification): EventCursor =>
  `notifications.${Buffer.from(positionOf(notification), 'utf8').toString('base64url')}` as EventCursor;

function positionFromCursor(cursor: EventCursor): string | null {
  const encoded = String(cursor).replace(/^notifications\./u, '');
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  return decoded === '' ? null : decoded;
}

/** Reuse the mutation's own trace when the record carries one. */
function traceOf(notification: Notification): TraceCorrelationId {
  const mutation = notification.lastMutation as { readonly traceId?: string };
  return mutation.traceId === undefined
    ? mintTraceCorrelationId()
    : (mutation.traceId as TraceCorrelationId);
}

function eventOf(notification: Notification): NotificationEvent {
  return {
    eventId: `event_notification_${String(notification.id)}_${String(notification.recordVersion)}`,
    kind: 'supervision.notification.changed',
    schemaVersion: 1,
    occurredAt: notification.createdAt,
    committedAt: notification.createdAt,
    sourceOwner: 'supervision',
    traceId: traceOf(notification),
    cursor: cursorOf(notification),
    payload: notification,
  };
}

/**
 * One bounded, cursor-resumable page of notification events.
 *
 * `after` is exclusive and compared on the same `(createdAt,id)` position the
 * cursor encodes, so resuming can neither repeat a row nor skip one — the two
 * ways a paged reader silently loses an alert.
 */
export async function notificationEventPage(
  deps: DeliveryDependencies,
  input: NotificationEventPageInput,
): Promise<B3Result<NotificationEventPage>> {
  const stored = await deps.store.list<Notification>('notification');
  if (!stored.ok) return b3fail(stored.error);

  const ordered = [...stored.value].sort(
    (left, right) => positionOf(left).localeCompare(positionOf(right)),
  );
  const after = input.after === undefined ? null : positionFromCursor(input.after);
  const remaining = after === null
    ? ordered
    : ordered.filter((notification) => positionOf(notification) > after);

  const items = remaining.slice(0, input.limit).map(eventOf);
  const last = items[items.length - 1];
  const more = remaining.length > items.length;
  return b3ok({
    items,
    omissions: [],
    ...(more && last !== undefined ? { nextCursor: last.cursor } : {}),
  });
}

/**
 * The frozen `subscribeNotifications` signature, expressed over those pages.
 *
 * Abandoning the iterator is the cancellation the freeze describes; nothing is
 * retained between pulls beyond the cursor the caller already holds.
 */
export async function* subscribeNotifications(
  deps: DeliveryDependencies,
  after?: EventCursor,
): AsyncIterable<B3Result<NotificationEvent>> {
  let cursor = after;
  for (;;) {
    const page = await notificationEventPage(
      deps, { limit: 100, ...(cursor === undefined ? {} : { after: cursor }) },
    );
    if (!page.ok) {
      yield b3fail(page.error);
      return;
    }
    for (const event of page.value.items) yield b3ok(event);
    if (page.value.nextCursor === undefined) return;
    cursor = page.value.nextCursor;
  }
}
