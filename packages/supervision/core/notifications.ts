// The event-driven half of the wire: a committed event, and what it settles.
//
// §25-B3d's binding exit is that every one of these paths runs "WITHOUT
// watcher-created model polling turns". Nothing here can start one: the engine
// holds a store and its own contract, and no way to reach a PTY. An ordinary
// event that was already going to be published is the whole clock.
import {
  b3fail, b3ok, deriveClientOpId, nowIsoUtc, validationFailed,
  type ActivityGeneration, type B3Page, type B3PrincipalId, type B3Result, type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveNotificationId, isRunDisconnectedEdge, notificationDeliveryEffectKey, parsePublicEvent,
  subjectKey, SUPERVISION_RECORD_WRITER,
  type EvaluateSupervisionEventInput, type Notification, type NotificationFilter,
  type RunConnectionSnapshot, type WatchDeadline, type WatchRule,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';
import { claimDeadline } from './watchers/deadlines.js';

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
  return conditionNotification(
    principal, rule, deadline.subjectKey, deadline.activityGeneration, evidenceRef,
  );
}

/** Build the one stable Notification for a non-drift condition generation. */
function conditionNotification(
  principal: B3PrincipalId,
  rule: WatchRule,
  keyedSubject: string,
  activityGeneration: ActivityGeneration,
  evidenceRef: string,
): Persisted<Notification> & Record<string, unknown> {
  const notificationId = deriveNotificationId({
    watchRuleId: rule.id,
    subjectKey: keyedSubject,
    condition: rule.condition,
    activityGeneration,
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
    conditionGeneration: Number(activityGeneration),
    summary: `${rule.condition.kind} fired for ${keyedSubject}`,
    evidenceRefs: [evidenceRef],
    state: 'queued',
    deliveryMode: rule.deliveryMode,
    phase: 'condition',
  };
}

/** Queue a pre-built Notification exactly once under its deterministic ID. */
async function queueConditionNotification(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  record: Persisted<Notification> & Record<string, unknown>,
): Promise<B3Result<Notification | null>> {
  const existing = await deps.store.read<Notification>('notification', record.id);
  if (!existing.ok) return b3fail(existing.error);
  if (existing.value !== null) return b3ok(null);
  const written = await deps.store.create<Notification>(
    principal, record, deriveClientOpId(`b3v4:queue-notification:${record.id}`),
  );
  return written.ok ? b3ok(written.value) : b3fail(written.error);
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
  const queued = await queueConditionNotification(deps, principal, record);
  if (!queued.ok) return queued;
  const claimed = await claimDeadline({
    store: deps.store,
    clock: () => new Date(observedAt),
  }, input.deadline);
  if (!claimed.ok) return b3fail(claimed.error);
  const lateByMs = Math.max(
    0, new Date(observedAt).getTime() - new Date(input.deadline.dueAt).getTime(),
  );
  const fired = await deps.store.update<WatchDeadline>(
    principal, claimed.value.id, { state: 'fired', lateByMs },
    claimed.value.recordVersion, deriveClientOpId(`b3v4:fire-deadline:${claimed.value.id}`),
  );
  if (!fired.ok) return b3fail(fired.error);
  return b3ok(queued.value);
}

function activityGenerationOfEvent(
  payload: Readonly<Record<string, unknown>>,
): ActivityGeneration | null {
  const generation = payload['activityGeneration'];
  return Number.isInteger(generation) && Number(generation) >= 0
    ? generation as ActivityGeneration
    : null;
}

/** Manual event conditions that are true at one committed Runtime edge. */
function eventMatchesRule(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
  rule: WatchRule,
): boolean {
  if (rule.condition.kind === 'run-final') {
    return kind === 'agent.run.lifecycle.changed'
      && ['stopped', 'failed', 'interrupted'].includes(String(payload['toLifecycle']));
  }
  if (rule.condition.kind !== 'run-disconnected'
    || kind !== 'agent.run.connection.changed') return false;
  const previous = connectionSnapshot(payload['previous']);
  const current = connectionSnapshot(payload['current']);
  return previous !== null && current !== null
    && Number(current.activityGeneration) === Number(payload['activityGeneration'])
    && isRunDisconnectedEdge(previous, current);
}

function connectionSnapshot(candidate: unknown): RunConnectionSnapshot | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const record = candidate as Readonly<Record<string, unknown>>;
  const generation = record['activityGeneration'];
  const uncertaintyCodes = record['uncertaintyCodes'];
  if (typeof record['final'] !== 'boolean'
    || !Number.isInteger(generation) || Number(generation) < 0
    || !Array.isArray(uncertaintyCodes)
    || !uncertaintyCodes.every((code) => typeof code === 'string')) return null;
  return {
    final: record['final'],
    activityGeneration: generation as ActivityGeneration,
    uncertaintyCodes,
  };
}

async function settleEventRule(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  rule: WatchRule,
  event: {
    readonly kind: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly evidenceRef: string;
    readonly about: string | null;
  },
): Promise<B3Result<Notification | null>> {
  const keyedSubject = subjectKey(rule.subject);
  if (event.about !== keyedSubject || !eventMatchesRule(event.kind, event.payload, rule)) {
    return b3ok(null);
  }
  const generation = activityGenerationOfEvent(event.payload);
  if (generation === null) {
    return b3fail(validationFailed([{
      path: 'event.payload.activityGeneration',
      message: 'must be a non-negative integer for a lifecycle watcher edge',
    }]));
  }
  return queueConditionNotification(
    deps,
    principal,
    conditionNotification(principal, rule, keyedSubject, generation, event.evidenceRef),
  );
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
  const rules = await deps.store.list<WatchRule>('watchRule', { status: 'active' });
  if (!rules.ok) return b3fail(rules.error);
  for (const rule of rules.value) {
    const settled = await settleEventRule(deps, SUPERVISION_RECORD_WRITER, rule, {
      kind: parsed.value.kind,
      payload: parsed.value.payload,
      evidenceRef: parsed.value.eventId,
      about: event.about,
    });
    if (!settled.ok) return b3fail(settled.error);
    if (settled.value !== null) queued.push(settled.value);
  }
  return b3ok(queued);
}

/**
 * Settle clock-driven idle work even when the Runtime is otherwise silent.
 *
 * This is an embedded-host seam, not another public command. The durable
 * deadline remains the authority: every pass re-reads armed rows, claims the
 * exact record version, and the deterministic Notification absorbs replay.
 */
export async function evaluateDueDeadlines(
  deps: EvaluateDependencies,
  observedAt: IsoUtc,
): Promise<B3Result<readonly Notification[]>> {
  const armed = await deps.store.list<WatchDeadline>('watchDeadline', { state: 'armed' });
  if (!armed.ok) return b3fail(armed.error);
  const due = armed.value
    .filter((deadline) => String(deadline.dueAt) <= String(observedAt))
    .sort((left, right) => String(left.dueAt).localeCompare(String(right.dueAt))
      || String(left.id).localeCompare(String(right.id)));
  const queued: Notification[] = [];
  for (const deadline of due) {
    const settled = await settleOne(deps, SUPERVISION_RECORD_WRITER, deadline, {
      observedAt,
      evidenceRef: `watch-deadline:${String(deadline.id)}:due:${String(deadline.dueAt)}`,
      about: null,
    });
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
