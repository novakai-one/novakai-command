import {
  b3err, b3fail, b3ok, canonicalRequestHash,
  type ActivityGeneration, type AuthenticatedPrincipal, type B3PrincipalId, type B3Result,
  type IsoUtc,
} from '@novakai/foundation/contract';
import {
  isRunDisconnectedEdge, subjectKey, watchOccurrenceFamily,
  type Notification, type RunConnectionSnapshot, type WatchOccurrenceRelationshipAuthority,
  type WatchRule,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';
import type { UsageRunReader } from './usage/index.js';
import { conditionNotification, queueConditionNotification } from './condition-notifications.js';

interface LifecycleDependencies {
  readonly store: SupervisionStore;
  readonly runs?: UsageRunReader;
  readonly relationships?: WatchOccurrenceRelationshipAuthority;
}

export interface LifecycleEvent {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidenceRef: string;
  readonly qualifiedAt: IsoUtc;
  readonly about: string | null;
}

function connectionSnapshot(candidate: unknown): RunConnectionSnapshot | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const record = candidate as Readonly<Record<string, unknown>>;
  const generation = record['activityGeneration'];
  const uncertaintyCodes = record['uncertaintyCodes'];
  if (!['idle', 'working', 'waiting-provider', 'waiting-input', 'interrupting', 'unknown']
    .includes(String(record['activity']))
    || !Number.isInteger(generation) || Number(generation) < 0
    || !Array.isArray(uncertaintyCodes)
    || !uncertaintyCodes.every((code) => typeof code === 'string')
    || typeof record['observedAt'] !== 'string') return null;
  return {
    activity: record['activity'] as RunConnectionSnapshot['activity'],
    activityGeneration: generation as ActivityGeneration,
    uncertaintyCodes,
    observedAt: record['observedAt'] as IsoUtc,
  };
}

/** Manual event conditions that are true at one committed Runtime edge. */
function eventMatchesRule(event: LifecycleEvent, rule: WatchRule): boolean {
  if (rule.condition.kind === 'run-final') {
    return event.kind === 'agent.run.lifecycle.changed'
      && ['stopped', 'failed', 'interrupted'].includes(String(event.payload['toLifecycle']));
  }
  if (rule.condition.kind !== 'run-disconnected'
    || event.kind !== 'agent.run.activity.changed') {
    if (rule.condition.kind === 'child-needs-help') {
      return event.kind === 'runtime.recovery.required';
    }
    if (rule.condition.kind === 'operation-failed') {
      return event.kind === 'agent.run.operation.stage.changed';
    }
    return false;
  }
  const previous = connectionSnapshot(event.payload['previous']);
  const current = connectionSnapshot(event.payload['current']);
  return previous !== null && current !== null
    && Number(current.activityGeneration) === Number(event.payload['activityGeneration'])
    && isRunDisconnectedEdge(previous, current);
}

async function subjectMatches(
  deps: LifecycleDependencies,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  facts: import('../contract/index.js').RunOccurrenceEventFacts,
): Promise<B3Result<boolean>> {
  if (rule.condition.kind !== 'child-needs-help') {
    if (rule.subject.kind === 'agent-run') {
      return b3ok(facts.agentRunId === rule.subject.agentRunId);
    }
    if (rule.subject.kind === 'agent') return b3ok(facts.agentId === rule.subject.agentId);
  }
  if (deps.relationships === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'managed-child occurrence authority is not composed',
      { stage: 'occurrence-derivation' }, true,
    ));
  }
  return deps.relationships.isDirectManagedChild(principal, {
    ...(rule.subject.kind === 'agent-run'
      ? { parentAgentRunId: rule.subject.agentRunId }
      : { parentAgentId: rule.subject.agentId }),
    childAgentId: facts.agentId,
  });
}

/** Construct one ordinary candidate from owner-validated retained event facts. */
export async function lifecycleNotificationCandidate(
  deps: LifecycleDependencies,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  event: LifecycleEvent,
): Promise<B3Result<(Persisted<Notification> & Record<string, unknown>) | null>> {
  if (!eventMatchesRule(event, rule)) return b3ok(null);
  const family = watchOccurrenceFamily(rule.subject, rule.condition);
  if (deps.runs?.getRunOccurrenceEvent === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'retained Runtime occurrence lookup is not composed',
      { stage: 'occurrence-derivation', eventId: event.evidenceRef }, true,
    ));
  }
  const source = await deps.runs.getRunOccurrenceEvent(principal, event.evidenceRef);
  if (!source.ok) return source;
  if (source.value === null) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'the retained Runtime occurrence event is not visible',
      { stage: 'occurrence-derivation', eventId: event.evidenceRef }, true,
    ));
  }
  if (source.value.canonicalPayloadDigest !== canonicalRequestHash(event.payload)
    || source.value.occurredAt !== event.qualifiedAt) {
    return b3fail(b3err(
      'RecoveryRequired', 'caller event payload disagrees with retained Runtime truth',
      { stage: 'occurrence-derivation', eventId: event.evidenceRef }, true,
    ));
  }
  const expectedOccurrenceKind = rule.condition.kind === 'run-final'
    ? 'run-final'
    : rule.condition.kind === 'run-disconnected'
      ? 'run-disconnected'
      : rule.condition.kind === 'child-needs-help'
        ? 'child-needs-help'
        : rule.condition.kind === 'operation-failed'
          ? 'operation-failed'
          : null;
  if (source.value.kind !== event.kind
    || source.value.occurrenceKind !== expectedOccurrenceKind) {
    return b3fail(b3err(
      'RecoveryRequired', 'caller event kind disagrees with retained Runtime occurrence truth',
      { stage: 'occurrence-derivation', eventId: event.evidenceRef }, true,
    ));
  }
  const matches = await subjectMatches(deps, principal, rule, source.value);
  if (!matches.ok) return matches;
  if (!matches.value) return b3ok(null);
  if (family === 'L') {
    return b3ok(conditionNotification(
      principal.id,
      rule,
      subjectKey(rule.subject),
      source.value.activityGeneration,
      source.value.eventId,
      { occurrenceIdentity: 'legacy-generation', qualifiedAt: source.value.occurredAt },
    ));
  }
  const occurrence = family === 'AR'
    ? {
        occurrenceIdentity: 'agent-run' as const,
        qualifiedAt: source.value.occurredAt,
        conditionOccurrence: {
          kind: 'run-final' as const,
          agentRunId: source.value.agentRunId,
          providerSessionId: source.value.providerSessionId,
          qualifyingEvidenceRef: source.value.eventId,
          qualifiedAt: source.value.occurredAt,
        },
      }
    : family === 'EV'
      ? {
          occurrenceIdentity: 'committed-event' as const,
          qualifiedAt: source.value.occurredAt,
          conditionOccurrence: {
            kind: 'committed-event' as const,
            eventId: source.value.eventId,
            agentRunId: source.value.agentRunId,
            providerSessionId: source.value.providerSessionId,
            qualifyingEvidenceRef: source.value.eventId,
            qualifiedAt: source.value.occurredAt,
          },
        }
      : source.value.occurrenceKind === 'operation-failed'
        ? {
            occurrenceIdentity: 'run-operation' as const,
            qualifiedAt: source.value.occurredAt,
            conditionOccurrence: {
              kind: 'run-operation' as const,
              runOperationId: source.value.occurrence.runOperationId,
              agentRunId: source.value.agentRunId,
              providerSessionId: source.value.providerSessionId,
              qualifyingEvidenceRef: source.value.eventId,
              qualifiedAt: source.value.occurredAt,
            },
          }
        : null;
  if (occurrence === null) return b3ok(null);
  return b3ok(conditionNotification(
    principal.id,
    rule,
    subjectKey(rule.subject),
    source.value.activityGeneration,
    source.value.eventId,
    occurrence,
  ));
}

async function settleRule(
  deps: LifecycleDependencies,
  principal: B3PrincipalId,
  rule: WatchRule,
  event: LifecycleEvent,
): Promise<B3Result<Notification | null>> {
  const candidate = await lifecycleNotificationCandidate(
    deps,
    { id: principal, kind: 'system', verifiedScopes: [] },
    rule,
    event,
  );
  if (!candidate.ok) return b3fail(candidate.error);
  if (candidate.value === null) return b3ok(null);
  return queueConditionNotification(
    deps,
    principal,
    candidate.value,
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
