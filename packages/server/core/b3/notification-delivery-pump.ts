// Bounded Runtime scanner for durable Supervision Notification work.
import type { AuthenticatedPrincipal } from '@novakai/foundation/contract';
import type { Notification, WatchDeadline } from '../../../supervision/contract/index.js';
import {
  createOutcomeAnnouncer, runKeyOf, type OutcomeAnnouncer,
} from './notification-delivery-announcer.js';
import type { NotificationDeliveryDiagnosis } from './notification-delivery-diagnosis.js';
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

interface DeliveryAttempt {
  readonly delivered: boolean;
  readonly runKey: string;
  readonly failure?: { readonly notificationId: string; readonly code: string };
  /** Why a considered Notification did not move. Never silent, never a bucket. */
  readonly skipped?: NotificationDeliveryDiagnosis;
  /** What a refusal code alone would not have said. */
  readonly refusalDiagnosis?: NotificationDeliveryDiagnosis;
  /** The thrown text behind an unexpected failure, which has no diagnosis. */
  readonly failureCause?: string;
}

function blockedBy(
  work: DeliveryWork, attemptedRuns: ReadonlySet<string>, runKey: string,
): NotificationDeliveryDiagnosis | null {
  if (runKey === '') return null;
  if (attemptedRuns.has(runKey)) {
    return { reason: 'run-already-delivered-this-pass', snapshot: { targetAgentRunId: runKey } };
  }
  return work.awaitingRuns.has(runKey)
    ? { reason: 'awaiting-transcript-observation', snapshot: { targetAgentRunId: runKey } }
    : null;
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
  const outcome = await deliverNotification(dependencies, notification);
  if (outcome.kind === 'delivered') return { delivered: true, runKey };
  if (outcome.kind === 'skipped') {
    return { delivered: false, runKey, skipped: outcome.diagnosis };
  }
  return {
    delivered: false,
    runKey,
    failure: { notificationId: notification.id, code: outcome.code },
    ...(outcome.diagnosis === undefined ? {} : { refusalDiagnosis: outcome.diagnosis }),
  };
}

/**
 * The same attempt, with an unexpected throw turned into a recorded refusal.
 *
 * `deliverNotification` was called bare inside the candidate loop, so ONE
 * Notification throwing ended the pass for every Notification after it — and
 * those lost their pass silently, because a candidate the loop never reached
 * publishes nothing at all. A throw is a delivery failure like any other: it
 * gets a code, a cause and its own event, and the loop goes on.
 *
 * `RecoveryRequired` and not a retryable code: nothing in a bounded pass can
 * know whether the next one will do better, and the honest reading of an
 * unhandled throw inside delivery is that something needs looking at.
 */
async function guardedAttempt(
  dependencies: NotificationDeliveryDependencies,
  work: DeliveryWork,
  attemptedRuns: ReadonlySet<string>,
  notification: Notification,
): Promise<DeliveryAttempt> {
  try {
    return await attemptNotification(dependencies, work, attemptedRuns, notification);
  } catch (error) {
    return {
      delivered: false,
      runKey: runKeyOf(notification),
      failure: { notificationId: notification.id, code: 'RecoveryRequired' },
      failureCause: String(error),
    };
  }
}

/** One diagnosis as one console line — the reason first, so a grep finds it. */
function said(diagnosis: NotificationDeliveryDiagnosis): string {
  return `${diagnosis.reason} ${JSON.stringify(diagnosis.snapshot)}`;
}

/** Say what one attempt did, on both channels. The three cases are exclusive. */
async function announceAttempt(
  announcer: OutcomeAnnouncer, notification: Notification, attempt: DeliveryAttempt,
): Promise<void> {
  if (attempt.delivered) {
    announcer.delivered(notification);
    return;
  }
  if (attempt.failure !== undefined) {
    announcer.report(`${notification.id} refused: ${attempt.failure.code}${
      attempt.refusalDiagnosis === undefined ? '' : ` ${said(attempt.refusalDiagnosis)}`}${
      attempt.failureCause === undefined ? '' : ` ${attempt.failureCause}`}`);
    await announcer.refused(
      notification, attempt.failure.code, attempt.refusalDiagnosis, attempt.failureCause,
    );
    return;
  }
  if (attempt.skipped !== undefined) {
    announcer.report(`${notification.id} skipped: ${said(attempt.skipped)}`);
    await announcer.skipped(notification, attempt.skipped);
  }
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
    const attempt = await guardedAttempt(options, work, attemptedRuns, notification);
    if (attempt.delivered) {
      delivered += 1;
      if (attempt.runKey !== '') attemptedRuns.add(attempt.runKey);
    }
    if (attempt.failure !== undefined) failures.push(attempt.failure);
    await announceAttempt(announcer, notification, attempt);
  }
  announcer.retain(new Set(work.candidates.map((notification) => notification.id)));
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
