// The event-driven half of the wire: a committed event, and what it settles.
//
// §25-B3d's binding exit is that every one of these paths runs "WITHOUT
// watcher-created model polling turns". Nothing here can start one: the engine
// holds a store and its own contract, and no way to reach a PTY. An ordinary
// event that was already going to be published is the whole clock.
import {
  b3fail, b3ok, deriveClientOpId, nowIsoUtc, validationFailed,
  type B3Page, type B3PrincipalId, type B3Result, type IsoUtc, type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveNotificationId, notificationDeliveryEffectKey, parsePublicEvent,
  SUPERVISION_RECORD_WRITER,
  type EvaluateSupervisionEventInput, type Notification, type NotificationFilter,
  type WatchDeadline, type WatchRule,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';

export interface EvaluateDependencies {
  readonly store: SupervisionStore;
}

type EvaluationContext = SystemCommandContext<
  'sys_agents' | 'sys_agent_runtime' | 'sys_transcript' | 'sys_messaging'
>;

/** The subject key an event is evidence ABOUT, or null when it names none. */
function subjectKeyOfEvent(payload: Readonly<Record<string, unknown>>): string | null {
  const agentRunId = payload['agentRunId'];
  return typeof agentRunId === 'string' ? `agent-run:${agentRunId}` : null;
}

function queuedNotification(
  principal: B3PrincipalId,
  rule: WatchRule,
  deadline: WatchDeadline,
  evidenceRef: string,
): Persisted<Notification> & Record<string, unknown> {
  const notificationId = deriveNotificationId({
    watchRuleId: rule.id,
    subjectKey: deadline.subjectKey,
    condition: rule.condition,
    activityGeneration: deadline.activityGeneration,
    phase: 'condition',
  });
  const effectKey = notificationDeliveryEffectKey(notificationId);
  return {
    kind: 'notification',
    id: notificationId,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: principal,
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: rule.id,
    subject: rule.subject,
    recipient: rule.recipient,
    conditionGeneration: Number(deadline.activityGeneration),
    summary: `${rule.condition.kind} fired for ${deadline.subjectKey}`,
    evidenceRefs: [evidenceRef],
    state: 'queued',
    deliveryMode: rule.deliveryMode,
    phase: 'condition',
  };
}

/**
 * Fire one due deadline and queue its Notification, exactly once.
 *
 * QUEUE FIRST, then stop being armed. The two orders are indistinguishable
 * when nothing goes wrong and differ exactly once — a crash between them.
 * Firing first loses the alert for ever: the deadline is no longer armed, so
 * no replay will ever queue it. Queueing first can at worst re-fire a deadline
 * whose Notification already exists, and its deterministic identity absorbs
 * that. Same reason the freeze pins queue-before-delivery at the C seam.
 */
async function fireDeadline(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  input: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  observedAt: IsoUtc,
  evidenceRef: string,
): Promise<B3Result<Notification | null>> {
  const record = queuedNotification(principal, input.rule, input.deadline, evidenceRef);
  const existing = await deps.store.read<Notification>('notification', record.id);
  if (!existing.ok) return b3fail(existing.error);
  let queued: Notification | null = null;
  if (existing.value === null) {
    const written = await deps.store.create<Notification>(
      principal, record, deriveClientOpId(`b3v4:queue-notification:${record.id}`),
    );
    if (!written.ok) return b3fail(written.error);
    queued = written.value;
  }
  const lateByMs = Math.max(
    0, new Date(observedAt).getTime() - new Date(input.deadline.dueAt).getTime(),
  );
  const fired = await deps.store.update<WatchDeadline>(
    principal, input.deadline.id, { state: 'fired', lateByMs },
    input.deadline.recordVersion, deriveClientOpId(`b3v4:fire-deadline:${input.deadline.id}`),
  );
  if (!fired.ok) return b3fail(fired.error);
  return b3ok(queued);
}

/** Push an idle deadline out; observed activity is why it has not fired. */
async function rearmDeadline(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  input: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  observedAt: IsoUtc,
): Promise<B3Result<null>> {
  if (input.rule.condition.kind !== 'idle-for-ms') return b3ok(null);
  const dueAt = new Date(
    new Date(observedAt).getTime() + input.rule.condition.value,
  ).toISOString();
  const written = await deps.store.update<WatchDeadline>(
    principal, input.deadline.id, { dueAt },
    input.deadline.recordVersion, deriveClientOpId(`b3v4:rearm:${input.deadline.id}:${observedAt}`),
  );
  return written.ok ? b3ok(null) : b3fail(written.error);
}

/** The three facts a committed event contributes to a watcher evaluation. */
interface ObservedEvent {
  readonly observedAt: IsoUtc;
  readonly evidenceRef: string;
  readonly about: string | null;
}

/** What one armed deadline does about one committed event. */
async function settleDeadline(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  input: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  event: ObservedEvent,
): Promise<B3Result<Notification | null>> {
  if (String(event.observedAt) >= String(input.deadline.dueAt)) {
    return fireDeadline(deps, principal, input, event.observedAt, event.evidenceRef);
  }
  if (event.about !== input.deadline.subjectKey) return b3ok(null);
  const rearmed = await rearmDeadline(deps, principal, input, event.observedAt);
  return rearmed.ok ? b3ok(null) : b3fail(rearmed.error);
}

/** One armed deadline, resolved against its own rule before it is settled. */
async function settleOne(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  deadline: WatchDeadline,
  event: ObservedEvent,
): Promise<B3Result<Notification | null>> {
  const rule = await deps.store.read<WatchRule>('watchRule', deadline.watchRuleId);
  if (!rule.ok) return b3fail(rule.error);
  if (rule.value === null || rule.value.status !== 'active') return b3ok(null);
  // Activity drift has its own evidence reducer, clocks, and fenced scheduler
  // command. Letting the generic event path settle it would skip all nine
  // durable drift steps and manufacture an ordinary condition notification.
  if (rule.value.condition.kind === 'activity-drift') return b3ok(null);
  return settleDeadline(deps, principal, { rule: rule.value, deadline }, event);
}

/**
 * The reducer §9.2 asks for: at-least-once committed events in, durable
 * Notifications out, and nothing in between that can talk to a model.
 */
export async function evaluateEvent(
  deps: EvaluateDependencies,
  _context: EvaluationContext,
  input: EvaluateSupervisionEventInput,
): Promise<B3Result<readonly Notification[]>> {
  const parsed = parsePublicEvent(input.event);
  if (!parsed.ok) {
    return b3fail(validationFailed([{ path: 'event', message: parsed.error.message }]));
  }
  const armed = await deps.store.list<WatchDeadline>('watchDeadline', { state: 'armed' });
  if (!armed.ok) return b3fail(armed.error);
  const event = {
    observedAt: parsed.value.occurredAt,
    evidenceRef: parsed.value.eventId,
    about: subjectKeyOfEvent(parsed.value.payload),
  };
  const queued: Notification[] = [];
  for (const deadline of armed.value) {
    const settled = await settleOne(deps, SUPERVISION_RECORD_WRITER, deadline, event);
    if (!settled.ok) return b3fail(settled.error);
    if (settled.value !== null) queued.push(settled.value);
  }
  return b3ok(queued);
}

/** §12.4's durable notification read, filtered and bounded. */
export async function listNotifications(
  deps: EvaluateDependencies, filter: NotificationFilter,
): Promise<B3Result<B3Page<Notification>>> {
  const stored = await deps.store.list<Notification>('notification');
  if (!stored.ok) return b3fail(stored.error);
  const wanted = stored.value.filter((notification) => {
    if (filter.state !== undefined && !filter.state.includes(notification.state)) return false;
    if (filter.recipient === undefined) return true;
    return JSON.stringify(notification.recipient) === JSON.stringify(filter.recipient);
  });
  return b3ok({ items: wanted.slice(0, filter.limit), omissions: [] });
}
