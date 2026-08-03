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
}

interface DeliveryWork {
  readonly candidates: readonly Notification[];
  readonly awaitingRuns: ReadonlySet<string>;
}

const DEFAULT_INTERVAL_MS = 500;
const LIMIT = 100;
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

function workFrom(
  notifications: readonly Notification[], claimedEffects: ReadonlySet<string>,
): DeliveryWork {
  const candidates = notifications.filter((notification) =>
    pending(notification) || needsDriftOutcomeReconcile(notification, claimedEffects));
  const awaitingRuns = new Set(notifications.flatMap((notification) =>
    !pending(notification)
      && !needsDriftOutcomeReconcile(notification, claimedEffects)
      && notification.subject.kind === 'agent-run'
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
}

async function attemptNotification(
  dependencies: NotificationDeliveryDependencies,
  work: DeliveryWork,
  attemptedRuns: ReadonlySet<string>,
  notification: Notification,
): Promise<DeliveryAttempt> {
  const runKey = runKeyOf(notification);
  const blockedByRun = runKey !== ''
    && (work.awaitingRuns.has(runKey) || attemptedRuns.has(runKey));
  if (blockedByRun) return { delivered: false, runKey };
  const code = await deliverNotification(dependencies, notification);
  if (code === '') return { delivered: true, runKey };
  return code === null
    ? { delivered: false, runKey }
    : { delivered: false, runKey, failure: { notificationId: notification.id, code } };
}

async function deliverWork(
  dependencies: NotificationDeliveryDependencies, work: DeliveryWork,
): Promise<NotificationDeliveryPass> {
  let delivered = 0;
  const failures: { notificationId: string; code: string }[] = [];
  const attemptedRuns = new Set<string>();
  for (const notification of work.candidates) {
    const attempt = await attemptNotification(dependencies, work, attemptedRuns, notification);
    if (attempt.delivered) {
      delivered += 1;
      if (attempt.runKey !== '') attemptedRuns.add(attempt.runKey);
    }
    if (attempt.failure !== undefined) failures.push(attempt.failure);
  }
  return { considered: work.candidates.length, delivered, failures };
}

async function runPass(
  options: NotificationDeliveryPumpOptions,
): Promise<NotificationDeliveryPass> {
  const listed = await options.supervision.listNotifications(reader, {
    state: ['queued', 'offered-to-endpoint', 'delivery-uncertain'], limit: LIMIT,
  });
  if (!listed.ok) {
    return { ...EMPTY, failures: [{ notificationId: '', code: listed.error.code }] };
  }
  const deadlines = await options.supervision.listWatchDeadlines(reader);
  if (!deadlines.ok) {
    return { ...EMPTY, failures: [{ notificationId: '', code: deadlines.error.code }] };
  }
  return deliverWork(
    options, workFrom(listed.value.items, claimedDriftEffects(deadlines.value)),
  );
}

/** Create a bounded, restart-scanning Runtime delivery loop. */
export function createNotificationDeliveryPump(
  options: NotificationDeliveryPumpOptions,
): NotificationDeliveryPump {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<NotificationDeliveryPass> | null = null;

  async function deliverOnce(): Promise<NotificationDeliveryPass> {
    if (inFlight !== null) return inFlight;
    const pass = runPass(options).finally(() => { inFlight = null; });
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
