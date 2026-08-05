/* eslint-disable id-length -- `ok` is the frozen result field every B3 caller
   reads (FZ-CLI-SCHEMA-001/011); renaming it here would mean this door no
   longer speaks the contract it exists to pass through. */
// shell/app/supervision.ts — the implementation behind FZ-VIEW-001's
// `supervision` read (`b3.supervision.listNotifications`) and the one mutation
// the notification surface offers (`b3.supervision.acknowledge`).
//
// Same two jobs as the Runs and communications doors: translate the published
// request into the published filter, and hand the answer back untouched. It does
// not sort (the screen orders for attention, from the fields the answer carries),
// does not re-page, does not decide which states are settleable, and does not
// turn a transport failure into a blank screen.
//
// It exists because the Shell had invented its own: `getNotificationInbox` and
// `acknowledgeNotification` were `ShellServices` methods that no host outside
// `app/mockServices.ts` implemented, so against a fully backed server the
// attention screen drew "Supervision is not available in this host" forever
// while these two published methods sat unread (L-14).
import {
  NOTIFICATION_VIEW_EXTRAS, NOTIFICATION_VIEW_FROZEN, NOTIFICATION_VIEW_REQUIRED,
  type ListNotificationsRequest, type NotificationPageView, type NotificationView,
} from '../contract/notificationRead.js';
import type { ShellReadResult, ShellSupervisionServices } from '../contract/agentRuns.js';
import type { B3ReadCall } from './agentRuns.js';

/** AMD-005 A5-01's ceiling, the same number the other two doors default to. */
const DEFAULT_LIMIT = 200;

/**
 * The published filter, built from the published request and nothing else.
 *
 * `limit` is always sent: the frozen parser REQUIRES it (`field.count('limit',
 * 1, …)`), so an omitted one comes back as a typed ValidationFailed rather than
 * as a capability-chosen default. Supplying it here is the same choice
 * `nvk agent list` makes for `--limit`, for the same reason.
 */
export function notificationFilterFor(
  request: ListNotificationsRequest,
): Record<string, unknown> {
  return {
    limit: request.limit ?? DEFAULT_LIMIT,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  };
}

function unavailable(message: string): ShellReadResult<never> {
  return { ok: false, error: { code: 'SupervisionUnavailable', message } };
}

function refused(
  error: { code?: unknown; message?: unknown } | undefined,
): ShellReadResult<never> {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'SupervisionUnavailable',
      message: typeof error?.message === 'string'
        ? error.message : 'Supervision refused the request',
    },
  };
}

interface WireFrame {
  ok?: unknown;
  value?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** Unwrap the frozen result envelope; a refusal is a value, never a throw. */
function readFrame(answer: unknown): ShellReadResult<unknown> {
  const frame = answer as WireFrame | null;
  if (frame === null || typeof frame !== 'object') {
    return unavailable('Supervision returned no answer');
  }
  if (frame.ok !== true) return refused(frame.error);
  return { ok: true, value: frame.value };
}

/** Parse from `unknown` at the seam; a wrong shape is a drawable state. */
function readPage(answer: unknown): ShellReadResult<NotificationPageView> {
  const frame = readFrame(answer);
  if (!frame.ok) return frame;
  const page = frame.value as { items?: unknown; omissions?: unknown } | null;
  if (page === null || typeof page !== 'object' || !Array.isArray(page.items)) {
    return unavailable('Supervision returned something that is not a page of notifications');
  }
  // Verbatim — not spread, not sorted, not renamed. `omissions` is defaulted to
  // an empty list ONLY when the answer carried none at all: an absent list is
  // "this page does not report omissions", which is what the frozen page shape
  // says when the field is missing, and is not the same claim as `count: 0`.
  return {
    ok: true,
    value: (Array.isArray(page.omissions)
      ? page
      : { ...page, omissions: [] }) as unknown as NotificationPageView,
  };
}

function readNotification(answer: unknown): ShellReadResult<NotificationView> {
  const frame = readFrame(answer);
  if (!frame.ok) return frame;
  if (frame.value === null || typeof frame.value !== 'object') {
    return unavailable('Supervision returned something that is not a Notification');
  }
  return { ok: true, value: frame.value as NotificationView };
}

function unknownFields(
  present: readonly string[], allowed: readonly string[],
): string[] {
  return present.filter((field) => !allowed.includes(field))
    .map((field) => `<notification>.${field} is not in the frozen projection`);
}

/**
 * The drift guard for the browser-safe copy, expressed as data.
 *
 * It reports in both directions — a field the projection carries that this copy
 * has never heard of, and a frozen fact that went missing on the way through.
 * The implemented record's extras are ALLOWED and NAMED
 * (`NOTIFICATION_VIEW_EXTRAS`, reported as L-17): tolerating them silently would
 * hide the discrepancy the orchestrator has to rule on, while rejecting them
 * would fail against the real product on every row.
 */
export function notificationDrift(item: unknown): readonly string[] {
  if (item === null || typeof item !== 'object') return ['<notification> is not an object'];
  const present = Object.keys(item as Record<string, unknown>);
  return [
    ...unknownFields(present, [...NOTIFICATION_VIEW_FROZEN, ...NOTIFICATION_VIEW_EXTRAS]),
    ...NOTIFICATION_VIEW_REQUIRED
      .filter((field) => !present.includes(field))
      .map((field) => `<notification>.${field} is missing from the projection`),
  ];
}

export function createShellSupervisionServices(
  options: { readonly call: B3ReadCall },
): ShellSupervisionServices {
  return {
    async listNotifications(request) {
      try {
        return readPage(await options.call(
          'b3.supervision.listNotifications',
          notificationFilterFor(request),
        ));
      } catch (cause) {
        // A dead socket is a state the screen must be able to DRAW, not an
        // exception that blanks it (FZ-CLI-SCHEMA-011).
        return unavailable(cause instanceof Error ? cause.message : String(cause));
      }
    },
    /**
     * Settle one Notification. The ONLY mutation this surface offers, because
     * the frozen state machine accepts an acknowledgement from
     * `transcript-observed` and from nothing else — and it is the CAPABILITY
     * that enforces that, not this door. A refusal comes back as a drawable
     * failure so the screen can say what happened instead of pretending.
     */
    async acknowledge(notificationId) {
      try {
        return readNotification(await options.call(
          'b3.supervision.acknowledge', { notificationId },
        ));
      } catch (cause) {
        return unavailable(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}
