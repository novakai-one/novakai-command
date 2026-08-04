// What a Notification delivery pass says about itself, and where it says it.
//
// The pump decides; this module is the only thing that records. It was inline
// in the pump until NVK-KIMI-081, where the recording — not the deciding — was
// the defect: a live next-turn-context Notification went silent for exactly the
// duration of its lawful delivery window because ONE outcome event failed to
// publish and the announcer had already written it off as published.
import type { Notification } from '../../../supervision/contract/index.js';
import type { AgentRunsContract } from '../../../agent-runtime/contract/index.js';
import type { NotificationDeliveryDiagnosis } from './notification-delivery-diagnosis.js';

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

/** Which Run a Notification is about, or `''` when it is about none. */
export function runKeyOf(notification: Notification): string {
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
  notification: Notification, outcome: Readonly<Record<string, unknown>>,
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
export interface OutcomeAnnouncer {
  report(message: string): void;
  skipped(notification: Notification, diagnosis: NotificationDeliveryDiagnosis): Promise<void>;
  refused(
    notification: Notification, code: string, diagnosis?: NotificationDeliveryDiagnosis,
    cause?: string,
  ): Promise<void>;
  passRefused(stage: string, code: string): Promise<void>;
  delivered(notification: Notification): void;
  /** Forget every Notification this pass no longer considers. */
  retain(considered: ReadonlySet<string>): void;
}

export interface OutcomeAnnouncerOptions {
  readonly runs: AgentRunsContract;
  /** Reported per pass, because a skip nobody can read is a defect nobody can find. */
  readonly reportFailure?: (message: string) => void;
}

export function createOutcomeAnnouncer(
  options: OutcomeAnnouncerOptions,
): OutcomeAnnouncer {
  const report = options.reportFailure ?? ((message: string) => {
    console.error(`[notification-delivery] ${message}`);
  });
  // A fenced Notification skips on EVERY pass, twice a second by default. One
  // event per pass would be a durable record of the clock, not of the defect,
  // so an outcome is published when it becomes true and again only when it
  // changes.
  const announced = new Map<string, string>();

  /**
   * Put one outcome on the durable stream, or say why it is not there.
   *
   * A publish that refuses is reported and NOT thrown: the pump's job is to
   * keep delivering. A publish that THREW used to travel all the way out of
   * the candidate loop, so every Notification after it lost the pass without
   * publishing anything at all — the loudest possible failure producing the
   * quietest possible record.
   */
  async function publish(
    kind: string, payload: Readonly<Record<string, unknown>>, subject: string,
  ): Promise<boolean> {
    try {
      const published = await options.runs.publishCapabilityEvent(kind, payload, 'server');
      if (published.ok) return true;
      report(`${subject} outcome event refused: ${published.error.code}`);
    } catch (error) {
      report(`${subject} outcome event threw: ${String(error)}`);
    }
    return false;
  }

  /**
   * The dedupe entry is what makes a steady block cost one event instead of
   * one per pass — so an entry written for an event that never landed is the
   * difference between "published once" and "published never".
   *
   * The live defect marked it BEFORE the publish. One transient refusal at the
   * moment a Notification's window opened therefore suppressed every later
   * pass for as long as that outcome held: no skip, no refusal, no delivery,
   * for the whole ~90 second window. The mark now happens only once the event
   * is durably accepted, so an unrecorded outcome is retried on the next pass
   * instead of being remembered as recorded.
   *
   * The previous entry is left alone rather than cleared: it names what the
   * stream actually last carried for this subject, and re-publishing that
   * would be a duplicate of a fact already there.
   */
  async function announce(
    subject: string, outcome: string, kind: string, payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (announced.get(subject) === outcome) return;
    if (await publish(kind, payload, subject)) announced.set(subject, outcome);
  }

  return {
    report,
    // Keyed on the sub-reason, not the snapshot: the reason is the diagnosis,
    // and a key that included changing generations would publish the clock.
    skipped: (notification, diagnosis) => announce(
      notification.id, `skipped:${diagnosis.reason}`, SKIPPED_EVENT,
      deliveryReport(notification, { reason: diagnosis.reason, observed: diagnosis.snapshot }),
    ),
    // Keyed on the code alone, `cause` included: the key stays stable across
    // passes while the message a reader needs to act on still reaches the
    // stream. A key carrying the message would publish whatever varies in it.
    refused: (notification, code, diagnosis, cause) => announce(
      notification.id, `refused:${code}`, REFUSED_EVENT, deliveryReport(notification, {
        code,
        ...(diagnosis === undefined
          ? {}
          : { reason: diagnosis.reason, observed: diagnosis.snapshot }),
        ...(cause === undefined ? {} : { cause }),
      }),
    ),
    passRefused: (stage, code) => announce(
      `pass:${stage}`, `refused:${code}`, REFUSED_EVENT, { stage, code },
    ),
    delivered: (notification) => { announced.delete(notification.id); },
    // Outcome memory is per-Notification, and this loop runs for the life of
    // the process. A Notification that leaves the pump's window is done with
    // it, so its entry goes too rather than accumulating for ever.
    retain: (considered) => {
      for (const subject of announced.keys()) {
        if (!subject.startsWith('pass:') && !considered.has(subject)) announced.delete(subject);
      }
    },
  };
}
