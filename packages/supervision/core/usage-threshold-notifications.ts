import {
  b3err, b3fail, b3ok,
  type ActivityGeneration, type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import {
  parseProviderUsageEvidenceCommittedEvent, subjectKey, SUPERVISION_RECORD_WRITER,
  type Notification, type ProviderUsageEvidence, type RunUsageFacts,
  type WatchCondition, type WatchRule,
} from '../contract/index.js';
import { conditionNotification, queueConditionNotification } from './condition-notifications.js';
import type { SupervisionStore } from './store.js';
import type { UsageRunReader } from './usage/index.js';
import type { UsageRunFacts } from './usage/index.js';
import type { WatchRuleGenerationPort } from './watchers/rules.js';

export interface UsageThresholdDependencies {
  readonly store: SupervisionStore;
  readonly runs?: UsageRunReader;
  readonly generation?: WatchRuleGenerationPort;
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
  runs: UsageRunReader,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  evidence: ProviderUsageEvidence,
): Promise<B3Result<RunUsageFacts | UsageRunFacts | null>> {
  const resolved = runs.resolveUsageRunByProviderSession === undefined
    ? rule.subject.kind === 'agent-run'
      ? await runs.getUsageRun(principal, rule.subject.agentRunId)
      : await runs.listUsageRuns(principal, rule.subject.agentId)
        .then((listed) => listed.ok
          ? b3ok(listed.value.find(
              (run) => run.providerSessionId === evidence.providerSessionId,
            ) ?? null)
          : listed)
    : await runs.resolveUsageRunByProviderSession(principal, evidence.providerSessionId);
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
  return b3ok(null);
}

async function settleRule(
  deps: Required<UsageThresholdDependencies>,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  evidence: ProviderUsageEvidence,
): Promise<B3Result<Notification | null>> {
  const condition = thresholdCondition(rule.condition);
  if (condition === null) return b3ok(null);
  const observed = observedValue(condition, evidence);
  if (observed === undefined || observed < condition.value) return b3ok(null);
  const resolved = await resolveEvidenceRun(deps.runs, principal, rule, evidence);
  if (!resolved.ok) return b3fail(resolved.error);
  if (resolved.value === null) return b3ok(null);
  let generation: ActivityGeneration;
  if ('activityGeneration' in resolved.value) {
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
        qualifiedAt: evidence.observedAt,
      }
    : {
        occurrenceIdentity: 'agent-run' as const,
        qualifiedAt: evidence.observedAt,
        conditionOccurrence: {
          kind: 'agent-run' as const,
          agentRunId: resolved.value.agentRunId,
          providerSessionId: resolved.value.providerSessionId,
          qualifyingEvidenceRef: evidence.id,
          qualifiedAt: evidence.observedAt,
        },
      };
  return queueConditionNotification(
    deps,
    SUPERVISION_RECORD_WRITER,
    conditionNotification(
      SUPERVISION_RECORD_WRITER,
      rule,
      subjectKey(rule.subject),
      generation,
      String(evidence.id),
      occurrence,
    ),
  );
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
  };
  for (const rule of thresholdRules) {
    const settled = await settleRule(complete, principal, rule, evidence);
    if (!settled.ok) return b3fail(settled.error);
    if (settled.value !== null) queued.push(settled.value);
  }
  return b3ok(queued);
}
