import {
  b3fail, b3ok, validationFailed,
  type ActivityGeneration, type B3PrincipalId, type B3Result,
} from '@novakai/foundation/contract';
import {
  isRunDisconnectedEdge, subjectKey,
  type Notification, type RunConnectionSnapshot, type WatchRule,
} from '../contract/index.js';
import type { SupervisionStore } from './store.js';
import { conditionNotification, queueConditionNotification } from './condition-notifications.js';

interface LifecycleDependencies {
  readonly store: SupervisionStore;
}

export interface LifecycleEvent {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidenceRef: string;
  readonly about: string | null;
}

function activityGenerationOfEvent(
  payload: Readonly<Record<string, unknown>>,
): ActivityGeneration | null {
  const generation = payload['activityGeneration'];
  return Number.isInteger(generation) && Number(generation) >= 0
    ? generation as ActivityGeneration
    : null;
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

/** Manual event conditions that are true at one committed Runtime edge. */
function eventMatchesRule(event: LifecycleEvent, rule: WatchRule): boolean {
  if (rule.condition.kind === 'run-final') {
    return event.kind === 'agent.run.lifecycle.changed'
      && ['stopped', 'failed', 'interrupted'].includes(String(event.payload['toLifecycle']));
  }
  if (rule.condition.kind !== 'run-disconnected'
    || event.kind !== 'agent.run.connection.changed') return false;
  const previous = connectionSnapshot(event.payload['previous']);
  const current = connectionSnapshot(event.payload['current']);
  return previous !== null && current !== null
    && Number(current.activityGeneration) === Number(event.payload['activityGeneration'])
    && isRunDisconnectedEdge(previous, current);
}

async function settleRule(
  deps: LifecycleDependencies,
  principal: B3PrincipalId,
  rule: WatchRule,
  event: LifecycleEvent,
): Promise<B3Result<Notification | null>> {
  const keyedSubject = subjectKey(rule.subject);
  if (event.about !== keyedSubject || !eventMatchesRule(event, rule)) return b3ok(null);
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

export async function settleLifecycleEventRules(
  deps: LifecycleDependencies,
  principal: B3PrincipalId,
  rules: readonly WatchRule[],
  event: LifecycleEvent,
): Promise<B3Result<readonly Notification[]>> {
  const queued: Notification[] = [];
  for (const rule of rules) {
    const settled = await settleRule(deps, principal, rule, event);
    if (!settled.ok) return b3fail(settled.error);
    if (settled.value !== null) queued.push(settled.value);
  }
  return b3ok(queued);
}
