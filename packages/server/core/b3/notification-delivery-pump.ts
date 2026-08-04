// Bounded Runtime scanner for durable Supervision Notification work.
import type { AuthenticatedPrincipal } from '@novakai/foundation/contract';
import type { Notification, WatchDeadline } from '../../../supervision/contract/index.js';
import {
  deliverNotification, type NotificationDeliveryDependencies,
} from './notification-delivery-worker.js';

export interface NotificationDeliveryPass {
  readonly considered: number;
  readonly delivered: number;
  readonly failures: readonly { readonly notificationId: string; readonly code: string }[];
}

export interface NotificationDeliveryPump {
  deliverOnce(): Promise<NotificationDeliveryPass>;
  start(): void;
  stop(): Promise<void>;
}

export interface NotificationDeliveryPumpOptions extends NotificationDeliveryDependencies {
  readonly intervalMs?: number;
  /** Reported per pass, because a skip nobody can read is a defect nobody can find. */
  readonly reportFailure?: (message: string) => void;
  readonly clock?: () => number;
}

interface DeliveryWork {
  readonly candidates: readonly Notification[];
  readonly awaitingRuns: ReadonlySet<string>;
}

const DEFAULT_INTERVAL_MS = 500;
const LIMIT = 100;
/**
 * How long a delivered-but-unobserved Notification may fence its own Run.
 *
 * `offered-to-endpoint` has exactly one exit — Q11 transcript observation — and
 * that evidence provably may never arrive for a real provider turn. An
 * unbounded fence therefore starved every later Notification on that Run for
 * the life of the process. Past this window the delivery is treated as no
 * longer in flight; the Run's own generation fence and the Terminal input
 * boundary still decide whether the next one may actually land.
 */
const OBSERVATION_GRACE_MS = 300_000;
/**
 * The durable half of "no skip is silent".
 *
 * `reportFailure` defaults to `console.error`, which is exactly as readable as
 * nothing at all to anything diagnosing this after the process is gone — the
 * live defect cost two full runs for that reason. Every outcome therefore also
 * lands on the ONE run event stream, which Runtime retains as a durable
 * `runOccurrenceEvent` before any consumer can observe it.
 *
 * `sourceOwner` is `server`, not `supervision`: the pump makes this decision,
 * and `SUPERVISION_EVENT_KINDS` is the closed set of §15 rows Supervision
 * itself publishes.
 */
const SKIPPED_EVENT = 'supervision.notification.delivery-skipped';
const REFUSED_EVENT = 'supervision.notification.delivery-refused';
const EMPTY: NotificationDeliveryPass = { considered: 0, delivered: 0, failures: [] };
const reader: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};

function pending(notification: Notification): boolean {
  return notification.deliveryAttempt.state === 'queued'
    || notification.deliveryAttempt.state === 'delivery-claimed';
}

function claimedDriftEffects(deadlines: readonly WatchDeadline[]): ReadonlySet<string> {
  return new Set(deadlines.flatMap((deadline) => {
    const drift = deadline.driftState;
    return drift?.phase === 'status-outstanding'
      && drift.outstandingStatus.state === 'delivery-claimed'
      ? [drift.outstandingStatus.effectKey] : [];
  }));
}

function needsDriftOutcomeReconcile(
  notification: Notification, claimedEffects: ReadonlySet<string>,
): boolean {
  return notification.phase === 'drift-status-request'
    && (notification.deliveryAttempt.state === 'submitted-confirmed'
      || notification.deliveryAttempt.state === 'submitted-unconfirmed')
    && claimedEffects.has(notification.deliveryEffectKey);
}

/** Is this delivery recent enough that transcript observation could still land? */
function observationStillPossible(notification: Notification, nowMs: number): boolean {
  const attempt = notification.deliveryAttempt;
  if (attempt.state !== 'submitted-confirmed' && attempt.state !== 'submitted-unconfirmed') {
    return true;
  }
  const submittedAt = Date.parse(String(attempt.submittedAt));
  return Number.isNaN(submittedAt) || nowMs - submittedAt < OBSERVATION_GRACE_MS;
}

function workFrom(
  notifications: readonly Notification[],
  claimedEffects: ReadonlySet<string>,
  nowMs: number,
): DeliveryWork {
  const candidates = notifications.filter((notification) =>
    pending(notification) || needsDriftOutcomeReconcile(notification, claimedEffects));
  const awaitingRuns = new Set(notifications.flatMap((notification) =>
    !pending(notification)
      && !needsDriftOutcomeReconcile(notification, claimedEffects)
      && notification.subject.kind === 'agent-run'
      && observationStillPossible(notification, nowMs)
      ? [String(notification.subject.agentRunId)] : []));
  return { candidates, awaitingRuns };
}

function runKeyOf(notification: Notification): string {
  return notification.subject.kind === 'agent-run'
    ? String(notification.subject.agentRunId) : '';
}

/**
 * What one outcome event says about one Notification.
 *
 * The Run is named `targetAgentRunId`, deliberately NOT `agentRunId`:
 * Supervision's reducer reads a top-level `agentRunId` as evidence ABOUT that
 * Run (`packages/supervision/core/notifications.ts:49`) and re-arms its armed
 * deadlines. This is a report about a delivery pass, never evidence that the
 * Agent did anything, and a pump that suppressed the idle watchers it reports
 * on would be worse than the silence it replaces.
 */
function deliveryReport(
  notification: Notification, outcome: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  const runKey = runKeyOf(notification);
  return {
    notificationId: notification.id,
    deliveryEffectKey: notification.deliveryEffectKey,
    ...(runKey === '' ? {} : { targetAgentRunId: runKey }),
    ...outcome,
  };
}

/** Both channels a pump outcome travels: the dev console and the event stream. */
interface OutcomeAnnouncer {
  report(message: string): void;
  skipped(notification: Notification, why: string): Promise<void>;
  refused(notification: Notification, code: string): Promise<void>;
  passRefused(stage: string, code: string): Promise<void>;
  delivered(notification: Notification): void;
}

function createOutcomeAnnouncer(
  options: NotificationDeliveryPumpOptions,
): OutcomeAnnouncer {
  const report = options.reportFailure ?? ((message: string) => {
    console.error(`[notification-delivery] ${message}`);
  });
  // A fenced Notification skips on EVERY pass, twice a second by default. One
  // event per pass would be a durable record of the clock, not of the defect,
  // so an outcome is published when it becomes true and again only when it
  // changes.
  const announced = new Map<string, string>();

  async function announce(
    key: string, outcome: string, kind: string, payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (announced.get(key) === outcome) return;
    announced.set(key, outcome);
    const published = await options.runs.publishCapabilityEvent(kind, payload, 'server');
    if (!published.ok) report(`${key} outcome event refused: ${published.error.code}`);
  }

  return {
    report,
    skipped: (notification, why) => announce(
      notification.id, `skipped:${why}`, SKIPPED_EVENT, deliveryReport(notification, { why }),
    ),
    refused: (notification, code) => announce(
      notification.id, `refused:${code}`, REFUSED_EVENT, deliveryReport(notification, { code }),
    ),
    passRefused: (stage, code) => announce(
      `pass:${stage}`, `refused:${code}`, REFUSED_EVENT, { stage, code },
    ),
    delivered: (notification) => { announced.delete(notification.id); },
  };
}

interface DeliveryAttempt {
  readonly delivered: boolean;
  readonly runKey: string;
  readonly failure?: { readonly notificationId: string; readonly code: string };
  /** Why a considered Notification did not move. Never silent. */
  readonly skipped?: string;
}

function blockedBy(
  work: DeliveryWork, attemptedRuns: ReadonlySet<string>, runKey: string,
): string | null {
  if (runKey === '') return null;
  if (attemptedRuns.has(runKey)) return 'run-already-delivered-this-pass';
  return work.awaitingRuns.has(runKey) ? 'awaiting-transcript-observation' : null;
}

async function attemptNotification(
  dependencies: NotificationDeliveryDependencies,
  work: DeliveryWork,
  attemptedRuns: ReadonlySet<string>,
  notification: Notification,
): Promise<DeliveryAttempt> {
  const runKey = runKeyOf(notification);
  const blocked = blockedBy(work, attemptedRuns, runKey);
  if (blocked !== null) return { delivered: false, runKey, skipped: blocked };
  const code = await deliverNotification(dependencies, notification);
  if (code === '') return { delivered: true, runKey };
  return code === null
    ? { delivered: false, runKey, skipped: 'not-deliverable-yet' }
    : { delivered: false, runKey, failure: { notificationId: notification.id, code } };
}

async function deliverWork(
  options: NotificationDeliveryPumpOptions,
  work: DeliveryWork,
  announcer: OutcomeAnnouncer,
): Promise<NotificationDeliveryPass> {
  let delivered = 0;
  const failures: { notificationId: string; code: string }[] = [];
  const attemptedRuns = new Set<string>();
  for (const notification of work.candidates) {
    const attempt = await attemptNotification(options, work, attemptedRuns, notification);
    if (attempt.delivered) {
      delivered += 1;
      if (attempt.runKey !== '') attemptedRuns.add(attempt.runKey);
      announcer.delivered(notification);
    }
    if (attempt.failure !== undefined) {
      failures.push(attempt.failure);
      announcer.report(`${notification.id} refused: ${attempt.failure.code}`);
      await announcer.refused(notification, attempt.failure.code);
    }
    if (attempt.skipped !== undefined) {
      announcer.report(`${notification.id} skipped: ${attempt.skipped}`);
      await announcer.skipped(notification, attempt.skipped);
    }
  }
  return { considered: work.candidates.length, delivered, failures };
}

async function runPass(
  options: NotificationDeliveryPumpOptions,
  announcer: OutcomeAnnouncer,
): Promise<NotificationDeliveryPass> {
  const listed = await options.supervision.listNotifications(reader, {
    state: ['queued', 'offered-to-endpoint', 'delivery-uncertain'], limit: LIMIT,
  });
  if (!listed.ok) {
    announcer.report(`listNotifications refused: ${listed.error.code}`);
    await announcer.passRefused('list-notifications', listed.error.code);
    return { ...EMPTY, failures: [{ notificationId: '', code: listed.error.code }] };
  }
  const deadlines = await options.supervision.listWatchDeadlines(reader);
  if (!deadlines.ok) {
    announcer.report(`listWatchDeadlines refused: ${deadlines.error.code}`);
    await announcer.passRefused('list-watch-deadlines', deadlines.error.code);
    return { ...EMPTY, failures: [{ notificationId: '', code: deadlines.error.code }] };
  }
  const nowMs = (options.clock ?? Date.now)();
  return deliverWork(
    options,
    workFrom(listed.value.items, claimedDriftEffects(deadlines.value), nowMs),
    announcer,
  );
}

/** Create a bounded, restart-scanning Runtime delivery loop. */
export function createNotificationDeliveryPump(
  options: NotificationDeliveryPumpOptions,
): NotificationDeliveryPump {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  // Held across passes, because "has this outcome changed?" is a question only
  // something that outlives one pass can answer.
  const announcer = createOutcomeAnnouncer(options);
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<NotificationDeliveryPass> | null = null;

  async function deliverOnce(): Promise<NotificationDeliveryPass> {
    if (inFlight !== null) return inFlight;
    const pass = runPass(options, announcer).finally(() => { inFlight = null; });
    inFlight = pass;
    return pass;
  }

  return {
    deliverOnce,
    start() {
      if (timer !== null) return;
      void deliverOnce();
      timer = setInterval(() => { void deliverOnce(); }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight !== null) await inFlight;
    },
  };
}
