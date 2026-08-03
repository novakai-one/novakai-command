import {
  b3err, b3fail, b3ok,
  type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import {
  parseProviderUsageEvidenceCommittedEvent, subjectKey, SUPERVISION_RECORD_WRITER,
  type Notification, type ProviderUsageEvidence, type WatchCondition, type WatchRule,
} from '../contract/index.js';
import { conditionNotification, queueConditionNotification } from './condition-notifications.js';
import type { SupervisionStore } from './store.js';
import type { UsageRunReader } from './usage/index.js';
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

async function evidenceMatchesRule(
  runs: UsageRunReader,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  evidence: ProviderUsageEvidence,
): Promise<B3Result<boolean>> {
  if (rule.subject.kind === 'agent-run') {
    const usageRun = await runs.getUsageRun(principal, rule.subject.agentRunId);
    return usageRun.ok
      ? b3ok(usageRun.value.providerSessionId === evidence.providerSessionId)
      : b3fail(usageRun.error);
  }
  if (rule.subject.kind === 'agent') {
    const known = await runs.listUsageRuns(principal, rule.subject.agentId);
    return known.ok
      ? b3ok(known.value.some(
        (usageRun) => usageRun.providerSessionId === evidence.providerSessionId,
      ))
      : b3fail(known.error);
  }
  return b3ok(false);
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
  const matches = await evidenceMatchesRule(deps.runs, principal, rule, evidence);
  if (!matches.ok) return b3fail(matches.error);
  if (!matches.value) return b3ok(null);
  const generation = await deps.generation.generationFor(principal, rule.subject);
  if (!generation.ok) return b3fail(generation.error);
  return queueConditionNotification(
    deps,
    SUPERVISION_RECORD_WRITER,
    conditionNotification(
      SUPERVISION_RECORD_WRITER,
      rule,
      subjectKey(rule.subject),
      generation.value,
      String(evidence.id),
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
  if (deps.runs === undefined || deps.generation === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable',
      'usage-threshold authorities are not composed in this host',
      { reason: 'usage-thresholds-not-composed' },
      true,
    ));
  }
  const evidence = parsed.value.payload as unknown as ProviderUsageEvidence;
  const queued: Notification[] = [];
  const complete = { store: deps.store, runs: deps.runs, generation: deps.generation };
  for (const rule of thresholdRules) {
    const settled = await settleRule(complete, principal, rule, evidence);
    if (!settled.ok) return b3fail(settled.error);
    if (settled.value !== null) queued.push(settled.value);
  }
  return b3ok(queued);
}
