// shell/contract/notificationRead.ts — the Shell's read of a Notification
// (FZ-VIEW-024, P2 §9.2:1640–1672), served by `b3.supervision.listNotifications`.
//
// A browser-safe COPY, under the same two rules as the Runs, communications and
// tree doors:
//
//   1. FIELD NAMES ARE VERBATIM. `watchRuleId` stays `watchRuleId`. Nothing is
//      renamed, flattened, defaulted or dropped on the way to the browser.
//   2. LEAVES THAT ARE UNIONS UPSTREAM ARE `string` HERE. `state`, `deliveryMode`
//      and `phase` are shown as text; this Shell never decides what the set of
//      legal values is. Union-of-OBJECTS members (`subject`, `recipient`) keep
//      their discriminants, because the discriminant selects which sibling
//      fields exist — the same distinction `RunSupervisorView` is copied under.
//
// This file replaces an invented one. Until B2.5 the inbox rendered a Shell-made
// seven-field row supplied by a Shell-made service method that no host outside
// `app/mockServices.ts` implemented (L-14). Four frozen facts were missing, and
// the most expensive of them was `phase`: `drift-human-escalation` is Supervision
// saying A HUMAN IS BEING ASKED TO INTERVENE, and it was arriving on the one
// screen whose entire job is attention looking exactly like an ordinary
// threshold alert.
//
// Rule 2 has a second payoff worth naming, because the invented copy got it
// wrong: a state outside the six is drawn as ITSELF. The old `Record<State,…>`
// lookups returned `undefined` for anything unfamiliar, which is how a host one
// version ahead would have printed "undefined" into the attention surface and
// sorted the row by `NaN`.

/** The frozen row, verbatim. Optional members are optional upstream too. */
export interface NotificationView {
  readonly id: string;
  readonly createdAt: string;
  readonly watchRuleId: string;
  readonly subject: NotificationSubjectView;
  readonly recipient: NotificationRecipientView;
  readonly conditionGeneration: number;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly state: string;
  readonly deliveryMode: string;
  readonly phase: string;
  readonly driftEpisodeId?: string;
}

/** `WatchSubject`, verbatim — what is being watched. */
export type NotificationSubjectView =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'agent-run'; readonly agentRunId: string }
  | { readonly kind: 'children-of'; readonly agentId: string };

/** `NotificationRecipient`, verbatim — who is being told. */
export type NotificationRecipientView =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'human'; readonly principalId: string };

/** `B3Page<Notification>` as the browser receives it. The Shell never re-pages. */
export interface NotificationPageView {
  readonly items: readonly NotificationView[];
  readonly nextCursor?: string;
  readonly omissions: readonly { readonly reason: string; readonly count: number }[];
}

/** What the screen holds: the page, plus when the Shell read it. */
export interface NotificationInboxView {
  readonly observedAt: string;
  readonly rows: readonly NotificationView[];
}

/** The published filter (`NotificationFilter`). `limit` is required upstream. */
export interface ListNotificationsRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * The phase that means Chris. Supervision publishes three, and only this one is
 * a request aimed at a human — `drift-status-request` asks the AGENT for a
 * status, and marking it would spend the screen's single signal on a row nobody
 * has to do anything about.
 */
export const HUMAN_ESCALATION_PHASE = 'drift-human-escalation';

export function isHumanEscalation(item: NotificationView): boolean {
  return item.phase === HUMAN_ESCALATION_PHASE;
}

// ── The drift guard's vocabulary ────────────────────────────────────────────

/** Every field FZ-VIEW-024 freezes, plus the envelope members this view reads. */
export const NOTIFICATION_VIEW_FROZEN: readonly string[] = [
  'id', 'createdAt',
  'watchRuleId', 'subject', 'recipient', 'conditionGeneration', 'summary',
  'evidenceRefs', 'state', 'deliveryMode', 'phase', 'driftEpisodeId',
];

/**
 * Fields the implemented record carries that FZ-VIEW-024 does NOT name.
 *
 * Listed rather than tolerated silently, for the reason B2.3 listed the
 * communications extras: a guard that shrugs at an unfrozen field hides the very
 * discrepancy the orchestrator has to rule on, and a guard that rejects one
 * fails against the real product on every row. Reported as L-17.
 *
 *   - `deliveryEffectKey`, `deliveryAttempt` — `NotificationBase` carries the
 *     durable Q7 delivery-attempt truth; the freeze row stops at `deliveryMode`.
 *   - `occurrenceIdentity`, `conditionOccurrence`, `qualifiedAt`, `deliveryFence`
 *     — the v2 occurrence-aware branch, which the freeze row does not describe.
 *   - the rest of `RecordEnvelope`, which every durable record carries.
 */
export const NOTIFICATION_VIEW_EXTRAS: readonly string[] = [
  'deliveryEffectKey', 'deliveryAttempt',
  'occurrenceIdentity', 'conditionOccurrence', 'qualifiedAt', 'deliveryFence',
  'kind', 'schemaVersion', 'recordVersion', 'permissionLevel', 'createdBy',
  'lastMutation',
];

/** Facts without which this screen cannot draw an honest row. */
export const NOTIFICATION_VIEW_REQUIRED: readonly string[] = [
  'id', 'watchRuleId', 'subject', 'recipient', 'conditionGeneration', 'summary',
  'evidenceRefs', 'state', 'deliveryMode', 'phase',
];

// ── Presentation (DOM-free, so the rules are testable without a screen) ──────

/** Finished, either way. Settled rows stay visible but stop competing. */
export function isSettled(item: NotificationView): boolean {
  return item.state === 'acknowledged' || item.state === 'expired';
}

/**
 * The rows a human could actually settle right now.
 *
 * `transcript-observed` and nothing else — the frozen state machine allows
 * `acknowledged` from that state alone. A `queued` or `offered-to-endpoint` row
 * has not been seen by anything yet, `delivery-uncertain` is the capability
 * saying it does not know, and an unrecognised state is this Shell not knowing.
 * Offering an ack on any of them would be offering a button the capability
 * refuses, which is worse than no button.
 */
export function awaitingAcknowledgement(
  rows: readonly NotificationView[],
): NotificationView[] {
  return rows.filter((item) => item.state === 'transcript-observed');
}

/**
 * Attention order: what needs him, then what is in flight, then what is done.
 *
 * An unrecognised state ranks with the uncertain rather than with the finished.
 * Sorting a state this Shell has never heard of to the bottom would be the Shell
 * deciding an unfamiliar fact is boring, which is the same judgement CL-S bans
 * everywhere else on this surface.
 */
const RANK: Readonly<Record<string, number>> = {
  'transcript-observed': 1,
  'delivery-uncertain': 2,
  'offered-to-endpoint': 4,
  queued: 5,
  acknowledged: 6,
  expired: 7,
};

const UNKNOWN_RANK = 3;

/**
 * A human being asked to intervene outranks every condition notification, seen
 * or not — that is what the phase MEANS. Once settled it stops outranking
 * anything, so the ordering releases with the marker.
 */
function rankOf(item: NotificationView): number {
  if (isHumanEscalation(item) && !isSettled(item)) return 0;
  return RANK[item.state] ?? UNKNOWN_RANK;
}

/**
 * Order is how this screen directs attention — it is not allowed to use words.
 *
 * Returns a new array; the caller's rows are never reordered in place, because
 * a list that mutates its input makes "render twice, get the same thing" false.
 */
export function orderInbox(rows: readonly NotificationView[]): NotificationView[] {
  return [...rows].sort((left, right) => {
    const byRank = rankOf(left) - rankOf(right);
    if (byRank !== 0) return byRank;
    return right.createdAt.localeCompare(left.createdAt);
  });
}

/**
 * The ONE row that is the exception right now, or null when nothing is.
 *
 * At most one, ever. Marking every waiting row is the design Chris rejected by
 * name — a badge on every row is noise wearing urgency's clothes. Settling the
 * marked row moves the marker to the next one, and settling the last releases it
 * entirely: the screen going calm IS the confirmation.
 *
 * The candidate set is "an unsettled human escalation, or a row that can be
 * settled" — deliberately wider than the settleable rows alone. A `queued`
 * escalation is the most important thing on the screen AND has nothing to press;
 * the mark says the first, the missing action says the second, and neither fact
 * is traded for the other.
 */
export function attentionIdOf(rows: readonly NotificationView[]): string | null {
  const candidates = rows.filter((item) =>
    (isHumanEscalation(item) && !isSettled(item)) || item.state === 'transcript-observed');
  return orderInbox(candidates)[0]?.id ?? null;
}

/** One noun per state. A fact about the row, never an instruction to the reader. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  queued: 'Queued',
  'offered-to-endpoint': 'Sent',
  'transcript-observed': 'Seen',
  acknowledged: 'Settled',
  'delivery-uncertain': 'Unconfirmed',
  expired: 'Expired',
};

/** A state outside the frozen six is drawn as itself — unknown as unknown. */
export function formatState(item: NotificationView): string {
  return STATE_WORDS[item.state] ?? item.state;
}

/** How the notification was meant to arrive — provenance, not instruction. */
const DELIVERY_WORDS: Readonly<Record<string, string>> = {
  'queue-only': 'inbox only',
  'next-turn-context': 'with the next turn',
  'start-turn': 'starts a turn',
};

export function formatDelivery(item: NotificationView): string {
  return DELIVERY_WORDS[item.deliveryMode] ?? item.deliveryMode;
}

/** What is being watched. Total over the three kinds the freeze names. */
export function describeSubject(item: NotificationView): string {
  const subject = item.subject;
  if (subject.kind === 'agent') return subject.agentId;
  if (subject.kind === 'agent-run') return subject.agentRunId;
  if (subject.kind === 'children-of') return `children of ${subject.agentId}`;
  return `unknown subject (${(subject as { readonly kind: string }).kind})`;
}

/** Who is being told. Notifications are addressed to Agents as well as people. */
export function describeRecipient(item: NotificationView): string {
  const recipient = item.recipient;
  if (recipient.kind === 'human') return recipient.principalId;
  if (recipient.kind === 'agent') return recipient.agentId;
  return `unknown recipient (${(recipient as { readonly kind: string }).kind})`;
}

/** "agent_kimi · starts a turn · Seen" — the quiet half of a row. */
export function formatRowMeta(item: NotificationView): string {
  return `${describeSubject(item)} · ${formatDelivery(item)} · ${formatState(item)}`;
}

/**
 * Why this notification exists, in the fields that justify it.
 *
 * All three were dropped by the invented row, and each answers a question the
 * summary alone cannot: which rule fired, which generation of that rule's
 * condition it fired on, and what evidence Supervision is standing on. An empty
 * `evidenceRefs` is SAID rather than skipped — a justification the screen simply
 * omits reads as a justification the screen has.
 */
export function describeProvenance(item: NotificationView): string {
  const count = item.evidenceRefs.length;
  const evidence = count === 0
    ? 'no evidence refs'
    : `${count} evidence ref${count === 1 ? '' : 's'}`;
  return `to ${describeRecipient(item)} · rule ${item.watchRuleId}`
    + ` · generation ${item.conditionGeneration} · ${evidence}`;
}

/**
 * The two lines under a row's headline, and which tier each of them is in.
 *
 * This exists because of what the browser showed and the DOM could not. Drawing
 * the escalation sentence on EVERY escalation put two full-ink lines on one
 * screen, identical in weight, the marked row distinguishable only by a 6px dot
 * — the third recurrence of the same defect in three seats (a fact and its
 * emphasis at the same ink tier). Every assertion was green: the sentence was
 * present, one row carried `--attention`, one mark existed. All true, and the
 * screen still read as two alarms.
 *
 * So scarcity is a rule here rather than a hope. The SENTENCE belongs to the
 * marked row alone; an escalation that is not the exception keeps the same fact
 * in the quiet tier, next to the rest of its provenance. Nothing is hidden and
 * only one thing shouts.
 */
export function describeRowFacts(
  item: NotificationView, attention: boolean,
): { readonly provenance: string; readonly escalation: string } {
  if (!isHumanEscalation(item)) {
    return { provenance: describeProvenance(item), escalation: '' };
  }
  const episode = item.driftEpisodeId === undefined ? '' : ` · ${item.driftEpisodeId}`;
  if (attention) {
    return {
      provenance: describeProvenance(item),
      escalation: `Supervision is asking a human to intervene${episode}`,
    };
  }
  return {
    provenance: `${describeProvenance(item)} · a human is being asked${episode}`,
    escalation: '',
  };
}

/**
 * What this answer cannot show, in its own numbers.
 *
 * `listNotifications` slices to `limit` and never sets `nextCursor` (L-15), so a
 * truncated inbox is byte-identical to a complete one and the Shell declines to
 * imply completeness. The omissions the page DOES report are stated, because a
 * page that hid rows is not the same page as one that hid none.
 */
export function inboxCompleteness(page: NotificationPageView): readonly string[] {
  const said: string[] = [];
  for (const omission of page.omissions) {
    if (omission.count > 0) said.push(`${omission.count} hidden · ${omission.reason}`);
  }
  if (page.nextCursor !== undefined) said.push('more notifications continue past this page');
  return said;
}
