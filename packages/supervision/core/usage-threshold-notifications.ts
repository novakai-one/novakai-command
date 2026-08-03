import {
  b3err, b3fail, b3ok, canonicalRequestHash,
  type ActivityGeneration, type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import {
  parseProviderUsageEvidenceCommittedEvent, parsePublicEvent, subjectKey,
  SUPERVISION_RECORD_WRITER,
  type Notification, type ProviderUsageEvidence, type RunUsageFacts,
  type RunOccurrenceEventFacts,
  type WatchCondition, type WatchOccurrenceRelationshipAuthority, type WatchRule,
} from '../contract/index.js';
import { conditionNotification, queueConditionNotification } from './condition-notifications.js';
import type { Persisted, SupervisionStore } from './store.js';
import type { UsageEvidenceReader, UsageRunReader } from './usage/index.js';
import type { UsageRunFacts } from './usage/index.js';
import type { WatchRuleGenerationPort } from './watchers/rules.js';

export interface UsageThresholdDependencies {
  readonly store: SupervisionStore;
  readonly runs?: UsageRunReader;
  readonly generation?: WatchRuleGenerationPort;
  readonly evidence?: UsageEvidenceReader;
  readonly relationships?: WatchOccurrenceRelationshipAuthority;
}

type ThresholdCondition = Extract<WatchCondition, {
  readonly kind:
    | 'turn-count-at-least'
    | 'input-tokens-at-least'
    | 'output-tokens-at-least'
    | 'cost-micros-at-least';
}>;

function thresholdCondition(condition: WatchCondition): ThresholdCondition | null {
  switch (condition.kind) {
    case 'turn-count-at-least':
    case 'input-tokens-at-least':
    case 'output-tokens-at-least':
    case 'cost-micros-at-least':
      return condition;
    default:
      return null;
  }
}

function observedValue(
  condition: ThresholdCondition,
  evidence: ProviderUsageEvidence,
): number | undefined {
  if (evidence.measurement.quality === 'unavailable') return undefined;
  switch (condition.kind) {
    case 'turn-count-at-least': return evidence.measurement.providerTurns;
    case 'input-tokens-at-least': return evidence.measurement.inputTokens;
    case 'output-tokens-at-least': return evidence.measurement.outputTokens;
    case 'cost-micros-at-least': return evidence.measurement.costMicros;
  }
}

async function resolveEvidenceRun(
  deps: Pick<UsageThresholdDependencies, 'runs' | 'relationships'> & {
    readonly runs: UsageRunReader;
  },
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  evidence: ProviderUsageEvidence,
): Promise<B3Result<RunUsageFacts | UsageRunFacts | null>> {
  const resolved = deps.runs.resolveUsageRunByProviderSession === undefined
    ? rule.subject.kind === 'agent-run'
      ? await deps.runs.getUsageRun(principal, rule.subject.agentRunId)
      : await deps.runs.listUsageRuns(principal, rule.subject.agentId)
        .then((listed) => listed.ok
          ? b3ok(listed.value.find(
              (run) => run.providerSessionId === evidence.providerSessionId,
            ) ?? null)
          : listed)
    : await deps.runs.resolveUsageRunByProviderSession(principal, evidence.providerSessionId);
  if (!resolved.ok) return resolved;
  if (resolved.value === null) {
    return b3fail(b3err(
      'RuntimeUnavailable',
      'the committed usage evidence Run is not yet visible',
      {
        reason: 'usage-run-not-yet-visible',
        providerSessionId: evidence.providerSessionId,
      },
      true,
    ));
  }
  const run = resolved.value;
  if (run.providerSessionId !== evidence.providerSessionId) {
    return b3fail(b3err(
      'RecoveryRequired',
      'Runtime correlation disagrees with the evidence ProviderSession',
      { stage: 'occurrence-derivation', providerSessionId: evidence.providerSessionId },
      true,
    ));
  }
  if (rule.subject.kind === 'agent-run') {
    return b3ok(run.agentRunId === rule.subject.agentRunId ? run : null);
  }
  if (rule.subject.kind === 'agent') {
    return b3ok(run.agentId === rule.subject.agentId ? run : null);
  }
  if (deps.relationships === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'managed-child usage authority is not composed',
      { stage: 'occurrence-derivation' }, true,
    ));
  }
  const related = await deps.relationships.isDirectManagedChild(principal, {
    parentAgentId: rule.subject.agentId,
    childAgentId: run.agentId,
  });
  if (!related.ok) return related;
  return b3ok(related.value ? run : null);
}

export async function usageThresholdCandidate(
  deps: UsageThresholdDependencies & Required<Pick<
    UsageThresholdDependencies, 'store' | 'runs' | 'generation' | 'evidence'
  >>,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  evidence: ProviderUsageEvidence,
  sourceOccurrence?: Extract<RunOccurrenceEventFacts, {
    readonly occurrenceKind: 'usage-generation';
  }>,
): Promise<B3Result<(Persisted<Notification> & Record<string, unknown>) | null>> {
  const condition = thresholdCondition(rule.condition);
  if (condition === null) return b3ok(null);
  if (deps.evidence.getProviderUsageEvidence === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'the Agents-owned usage evidence lookup is not composed',
      { stage: 'occurrence-derivation', providerUsageEvidenceId: evidence.id }, true,
    ));
  }
  const owned = await deps.evidence.getProviderUsageEvidence(principal, evidence.id);
  if (!owned.ok) return owned;
  if (owned.value === null) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'the committed usage evidence is not visible from Agents',
      { stage: 'occurrence-derivation', providerUsageEvidenceId: evidence.id }, true,
    ));
  }
  if (canonicalRequestHash(owned.value) !== canonicalRequestHash(evidence)) {
    return b3fail(b3err(
      'RecoveryRequired', 'caller usage evidence disagrees with Agents-owned truth',
      { stage: 'occurrence-derivation', providerUsageEvidenceId: evidence.id }, true,
    ));
  }
  const authoritativeEvidence = owned.value;
  const observed = observedValue(condition, authoritativeEvidence);
  if (observed === undefined || observed < condition.value) return b3ok(null);
  const resolved = await resolveEvidenceRun(deps, principal, rule, authoritativeEvidence);
  if (!resolved.ok) return b3fail(resolved.error);
  if (resolved.value === null) return b3ok(null);
  if (sourceOccurrence !== undefined
    && (sourceOccurrence.agentRunId !== resolved.value.agentRunId
      || sourceOccurrence.agentId !== resolved.value.agentId
      || sourceOccurrence.providerSessionId !== resolved.value.providerSessionId
      || sourceOccurrence.occurrence.qualifyingEvidenceRef !== authoritativeEvidence.id)) {
    return b3fail(b3err(
      'RecoveryRequired',
      'Runtime usage occurrence disagrees with Agents-owned evidence or Run correlation',
      { stage: 'occurrence-derivation', eventId: sourceOccurrence.eventId },
      true,
    ));
  }
  let generation: ActivityGeneration;
  if (rule.subject.kind === 'agent-run' && sourceOccurrence !== undefined) {
    generation = sourceOccurrence.activityGeneration;
  } else if ('activityGeneration' in resolved.value) {
    generation = resolved.value.activityGeneration;
  } else {
    const current = await deps.generation.generationFor(principal, rule.subject);
    if (!current.ok) return b3fail(current.error);
    generation = current.value;
  }
  if (rule.subject.kind !== 'agent-run' && !('activityGeneration' in resolved.value)) {
    return b3fail(b3err(
      'RuntimeUnavailable',
      'stable-subject occurrence correlation is not composed in this host',
      { reason: 'complete-provider-session-correlation-not-composed' },
      true,
    ));
  }
  const occurrence = rule.subject.kind === 'agent-run'
    ? {
        occurrenceIdentity: 'legacy-generation' as const,
        qualifiedAt: authoritativeEvidence.observedAt,
      }
    : {
        occurrenceIdentity: 'agent-run' as const,
        qualifiedAt: authoritativeEvidence.observedAt,
        conditionOccurrence: {
          kind: 'agent-run' as const,
          agentRunId: resolved.value.agentRunId,
          providerSessionId: resolved.value.providerSessionId,
          qualifyingEvidenceRef: authoritativeEvidence.id,
          qualifiedAt: authoritativeEvidence.observedAt,
        },
      };
  return b3ok(conditionNotification(
      SUPERVISION_RECORD_WRITER,
      rule,
      subjectKey(rule.subject),
      generation,
      rule.subject.kind === 'agent-run' && sourceOccurrence !== undefined
        ? sourceOccurrence.eventId
        : String(authoritativeEvidence.id),
      occurrence,
    ));
}

/** Parse one committed evidence event and build a candidate for one rule. */
export async function usageThresholdCandidateForEvent(
  deps: UsageThresholdDependencies,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  event: unknown,
): Promise<B3Result<(Persisted<Notification> & Record<string, unknown>) | null>> {
  if (thresholdCondition(rule.condition) === null) return b3ok(null);
  const eventKind = (event as { readonly kind?: unknown } | null)?.kind;
  if (eventKind !== 'agent.provider-usage-evidence.committed'
    && eventKind !== 'agent.run.usage.changed') return b3ok(null);
  if (deps.runs === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'usage-threshold authorities are not composed in this host',
      { reason: 'usage-thresholds-not-composed' }, true,
    ));
  }
  let evidence: ProviderUsageEvidence;
  let sourceOccurrence: Extract<RunOccurrenceEventFacts, {
    readonly occurrenceKind: 'usage-generation';
  }> | undefined;
  if (eventKind === 'agent.provider-usage-evidence.committed') {
    if (rule.subject.kind === 'agent-run') return b3ok(null);
    const parsed = parseProviderUsageEvidenceCommittedEvent(event);
    if (!parsed.ok) return b3fail(parsed.error);
    evidence = parsed.value.payload as unknown as ProviderUsageEvidence;
  } else {
    if (rule.subject.kind !== 'agent-run') return b3ok(null);
    const parsed = parsePublicEvent(event);
    if (!parsed.ok) return b3fail(parsed.error);
    if (parsed.value.sourceOwner !== 'agent-runtime'
      || deps.runs.getRunOccurrenceEvent === undefined) {
      return b3fail(b3err(
        'RuntimeUnavailable', 'Runtime usage occurrence authority is not composed',
        { stage: 'occurrence-derivation', eventId: parsed.value.eventId }, true,
      ));
    }
    const source = await deps.runs.getRunOccurrenceEvent(principal, parsed.value.eventId);
    if (!source.ok) return source;
    if (source.value === null
      || source.value.kind !== 'agent.run.usage.changed'
      || source.value.occurrenceKind !== 'usage-generation') {
      return b3fail(b3err(
        'RecoveryRequired', 'Runtime event is not retained usage-generation evidence',
        { stage: 'occurrence-derivation', eventId: parsed.value.eventId }, true,
      ));
    }
    if (source.value.canonicalPayloadDigest !== canonicalRequestHash(parsed.value.payload)
      || source.value.occurredAt !== parsed.value.occurredAt) {
      return b3fail(b3err(
        'RecoveryRequired', 'caller usage event disagrees with retained Runtime truth',
        { stage: 'occurrence-derivation', eventId: parsed.value.eventId }, true,
      ));
    }
    if (deps.evidence?.getProviderUsageEvidence === undefined) {
      return b3fail(b3err(
        'RuntimeUnavailable', 'Agents usage evidence lookup is not composed',
        { stage: 'occurrence-derivation', eventId: parsed.value.eventId }, true,
      ));
    }
    const owned = await deps.evidence.getProviderUsageEvidence(
      principal, source.value.occurrence.qualifyingEvidenceRef,
    );
    if (!owned.ok) return owned;
    if (owned.value === null) {
      return b3fail(b3err(
        'RuntimeUnavailable', 'Runtime usage occurrence cites unavailable Agents evidence',
        { stage: 'occurrence-derivation', eventId: parsed.value.eventId }, true,
      ));
    }
    evidence = owned.value;
    sourceOccurrence = source.value;
  }
  return usageThresholdCandidate({
    store: deps.store,
    runs: deps.runs,
    generation: deps.generation ?? {
      generationFor: async () => b3fail(b3err(
        'RuntimeUnavailable', 'watcher generationFor is not composed', {}, true,
      )),
    },
    evidence: deps.evidence ?? {
      listProviderUsageEvidence: async () => b3fail(b3err(
        'RuntimeUnavailable', 'usage evidence authority is not composed', {}, true,
      )),
    },
    ...(deps.relationships === undefined ? {} : { relationships: deps.relationships }),
  }, principal, rule, evidence, sourceOccurrence);
}

/** Reduce one committed usage fact into generation-fenced threshold Notifications. */
export async function settleUsageThresholdRules(
  deps: UsageThresholdDependencies,
  principal: AuthenticatedPrincipal,
  rules: readonly WatchRule[],
  event: unknown,
): Promise<B3Result<readonly Notification[]>> {
  if ((event as { readonly kind?: unknown } | null)?.kind
    !== 'agent.provider-usage-evidence.committed') return b3ok([]);
  const parsed = parseProviderUsageEvidenceCommittedEvent(event);
  if (!parsed.ok) return b3fail(parsed.error);
  const thresholdRules = rules.filter((rule) => thresholdCondition(rule.condition) !== null);
  if (thresholdRules.length === 0) return b3ok([]);
  if (deps.runs === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable',
      'usage-threshold authorities are not composed in this host',
      { reason: 'usage-thresholds-not-composed' },
      true,
    ));
  }
  const evidence = parsed.value.payload as unknown as ProviderUsageEvidence;
  const queued: Notification[] = [];
  const complete = {
    store: deps.store,
    runs: deps.runs,
    generation: deps.generation ?? {
      generationFor: async () => b3fail(b3err(
        'RuntimeUnavailable', 'watcher generationFor is not composed', {}, true,
      )),
    },
    evidence: deps.evidence ?? {
      listProviderUsageEvidence: async () => b3fail(b3err(
        'RuntimeUnavailable', 'usage evidence authority is not composed', {}, true,
      )),
    },
    ...(deps.relationships === undefined ? {} : { relationships: deps.relationships }),
  };
  for (const rule of thresholdRules) {
    const candidate = await usageThresholdCandidate(complete, principal, rule, evidence);
    if (!candidate.ok) return b3fail(candidate.error);
    if (candidate.value === null) continue;
    const settled = await queueConditionNotification(
      deps, SUPERVISION_RECORD_WRITER, candidate.value,
    );
    if (!settled.ok) return b3fail(settled.error);
    if (settled.value !== null) queued.push(settled.value);
  }
  return b3ok(queued);
}
