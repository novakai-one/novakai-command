// packages/shell/contract/notifications.ts — the notification inbox surface.
//
// Lane C's Shell half. The rules live here rather than in the component for the
// same reason the usage table's do: the things a screen can silently get wrong
// — "one exception, not many", "settling releases the marker", "the words are
// nouns" — are testable without a DOM, and a rule that is only enforced by JSX
// is a rule that survives exactly until the next refactor.
//
// The shell holds no notification truth. Rows arrive from Supervision as
// measured; nothing here infers a state, and nothing here offers an action the
// frozen capability would refuse.

/** The durable Notification states, exactly as Supervision publishes them. */
export type NotificationInboxState =
  | 'queued'
  | 'offered-to-endpoint'
  | 'transcript-observed'
  | 'acknowledged'
  | 'delivery-uncertain'
  | 'expired';

/** One row as Supervision's notification page delivers it. */
export interface NotificationRowView {
  id: string;
  summary: string;
  state: NotificationInboxState;
  deliveryMode: 'queue-only' | 'next-turn-context' | 'start-turn';
  recipient: string;
  subject: string;
  observedAt: string;
}

export interface NotificationInboxView {
  observedAt: string;
  rows: NotificationRowView[];
}

/** Finished, either way. Settled rows stay visible but stop competing. */
export function isSettled(item: NotificationRowView): boolean {
  return item.state === 'acknowledged' || item.state === 'expired';
}

/**
 * The rows a human could actually settle right now.
 *
 * `transcript-observed` and nothing else — the frozen state machine allows
 * `acknowledged` from that state alone. A `queued` or `offered-to-endpoint`
 * row has not been seen by anything yet, and `delivery-uncertain` is the
 * capability saying it does not know. Offering an ack on any of them would be
 * offering a button the capability refuses, which is worse than no button.
 */
export function awaitingAcknowledgement(
  rows: readonly NotificationRowView[],
): NotificationRowView[] {
  return rows.filter((item) => item.state === 'transcript-observed');
}

/** Attention order: what needs him, then what is in flight, then what is done. */
const RANK: Readonly<Record<NotificationInboxState, number>> = {
  'transcript-observed': 0,
  'delivery-uncertain': 1,
  'offered-to-endpoint': 2,
  queued: 3,
  acknowledged: 4,
  expired: 5,
};

/**
 * Order is how this screen directs attention — it is not allowed to use words.
 *
 * Returns a new array; the caller's rows are never reordered in place, because
 * a list that mutates its input makes "render twice, get the same thing" false.
 */
export function orderInbox(
  rows: readonly NotificationRowView[],
): NotificationRowView[] {
  return [...rows].sort((left, right) => {
    const byState = RANK[left.state] - RANK[right.state];
    if (byState !== 0) return byState;
    return right.observedAt.localeCompare(left.observedAt);
  });
}

/**
 * The ONE row that is the exception right now, or null when nothing is.
 *
 * At most one, ever. Marking every waiting row is the design Chris rejected by
 * name — a badge on every row is noise wearing urgency's clothes. Settling the
 * marked row moves the marker to the next one, and settling the last releases
 * it entirely: the screen going calm IS the confirmation.
 */
export function attentionIdOf(rows: readonly NotificationRowView[]): string | null {
  const waiting = orderInbox(awaitingAcknowledgement(rows));
  return waiting[0]?.id ?? null;
}

/** One noun per state. A fact about the row, never an instruction to the reader. */
const STATE_WORDS: Readonly<Record<NotificationInboxState, string>> = {
  queued: 'Queued',
  'offered-to-endpoint': 'Sent',
  'transcript-observed': 'Seen',
  acknowledged: 'Settled',
  'delivery-uncertain': 'Unconfirmed',
  expired: 'Expired',
};

export function formatState(item: NotificationRowView): string {
  return STATE_WORDS[item.state];
}

/** How the notification was meant to arrive — provenance, not instruction. */
const DELIVERY_WORDS: Readonly<Record<NotificationRowView['deliveryMode'], string>> = {
  'queue-only': 'inbox only',
  'next-turn-context': 'with the next turn',
  'start-turn': 'starts a turn',
};

export function formatDelivery(item: NotificationRowView): string {
  return DELIVERY_WORDS[item.deliveryMode];
}

/** "agent_kimi · starts a turn · Seen" — the quiet half of a row. */
export function formatRowMeta(item: NotificationRowView): string {
  return `${item.subject} · ${formatDelivery(item)} · ${formatState(item)}`;
}
