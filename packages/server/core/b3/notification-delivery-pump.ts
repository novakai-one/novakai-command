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
  readonly now?: () => number;
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
function observationStillPossible(notification: Notification, now: number): boolean {
  const attempt = notification.deliveryAttempt;
  if (attempt.state !== 'submitted-confirmed' && attempt.state !== 'submitted-unconfirmed') {
    return true;
  }
  const submittedAt = Date.parse(String(attempt.submittedAt));
  return Number.isNaN(submittedAt) || now - submittedAt < OBSERVATION_GRACE_MS;
}

function workFrom(
  notifications: readonly Notification[],
  claimedEffects: ReadonlySet<string>,
  now: number,
): DeliveryWork {
  const candidates = notifications.filter((notification) =>
    pending(notification) || needsDriftOutcomeReconcile(notification, claimedEffects));
  const awaitingRuns = new Set(notifications.flatMap((notification) =>
    !pending(notification)
      && !needsDriftOutcomeReconcile(notification, claimedEffects)
      && notification.subject.kind === 'agent-run'
      && observationStillPossible(notification, now)
      ? [String(notification.subject.agentRunId)] : []));
  return { candidates, awaitingRuns };
}

function runKeyOf(notification: Notification): string {
  return notification.subject.kind === 'agent-run'
    ? String(notification.subject.agentRunId) : '';
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
  report: (message: string) => void,
): Promise<NotificationDeliveryPass> {
  let delivered = 0;
  const failures: { notificationId: string; code: string }[] = [];
  const attemptedRuns = new Set<string>();
  for (const notification of work.candidates) {
    const attempt = await attemptNotification(options, work, attemptedRuns, notification);
    if (attempt.delivered) {
      delivered += 1;
      if (attempt.runKey !== '') attemptedRuns.add(attempt.runKey);
    }
    if (attempt.failure !== undefined) {
      failures.push(attempt.failure);
      report(`${notification.id} refused: ${attempt.failure.code}`);
    }
    if (attempt.skipped !== undefined) {
      report(`${notification.id} skipped: ${attempt.skipped}`);
    }
  }
  return { considered: work.candidates.length, delivered, failures };
}

async function runPass(
  options: NotificationDeliveryPumpOptions,
  report: (message: string) => void,
): Promise<NotificationDeliveryPass> {
  const listed = await options.supervision.listNotifications(reader, {
    state: ['queued', 'offered-to-endpoint', 'delivery-uncertain'], limit: LIMIT,
  });
  if (!listed.ok) {
    report(`listNotifications refused: ${listed.error.code}`);
    return { ...EMPTY, failures: [{ notificationId: '', code: listed.error.code }] };
  }
  const deadlines = await options.supervision.listWatchDeadlines(reader);
  if (!deadlines.ok) {
    report(`listWatchDeadlines refused: ${deadlines.error.code}`);
    return { ...EMPTY, failures: [{ notificationId: '', code: deadlines.error.code }] };
  }
  const now = (options.now ?? Date.now)();
  return deliverWork(
    options,
    workFrom(listed.value.items, claimedDriftEffects(deadlines.value), now),
    report,
  );
}

/** Create a bounded, restart-scanning Runtime delivery loop. */
export function createNotificationDeliveryPump(
  options: NotificationDeliveryPumpOptions,
): NotificationDeliveryPump {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const report = options.reportFailure ?? ((message: string) => {
    console.error(`[notification-delivery] ${message}`);
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<NotificationDeliveryPass> | null = null;

  async function deliverOnce(): Promise<NotificationDeliveryPass> {
    if (inFlight !== null) return inFlight;
    const pass = runPass(options, report).finally(() => { inFlight = null; });
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
