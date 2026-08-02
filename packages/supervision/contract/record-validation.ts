import {
  b3fail,
  type B3Result,
} from '@novakai/foundation/contract';
import type {
  AgentUsageSummary,
  DriftCheckOutcome,
} from './api.js';
import { validateDurableDriftState } from './drift-state-validation.js';
import type {
  AgentRunUsage,
  AgentUsageAggregate,
  UsageValue,
  WatchCondition,
  WatchDeadline,
  WatchRule,
} from './records.js';
import {
  parseAgentRunUsage,
  parseAgentUsageAggregate,
  parseCreateWatchRuleInput,
} from './validation.js';
import {
  exact,
  finish,
  identifier,
  isoUtc,
  nonEmpty,
  objectValue,
  oneOf,
  recordEnvelope,
  stringArray,
  wholeNumber,
  type ValidationIssue,
} from './validation-support.js';

/** Optional cross-record context for the driftState required/forbidden rule. */
export interface WatchDeadlineValidationContext {
  readonly conditionKind: WatchCondition['kind'];
}

/** Runtime parser for authoritative WatchRule output records. */
export function parseWatchRule(candidate: unknown): B3Result<WatchRule> {
  const input = parseCreateWatchRuleInput(candidate);
  if (!input.ok) return b3fail(input.error);
  const issues: ValidationIssue[] = [];
  const rule = objectValue(candidate, 'watchRule', issues);
  recordEnvelope(rule, 'watchRule', 'watchRule', 'uuidv7', issues);
  return finish<WatchRule>(candidate, issues);
}

/** Runtime parser for WatchDeadline, with optional linked-condition enforcement. */
export function parseWatchDeadline(
  candidate: unknown,
  context?: WatchDeadlineValidationContext,
): B3Result<WatchDeadline> {
  const issues: ValidationIssue[] = [];
  const deadline = objectValue(candidate, 'watchDeadline', issues);
  recordEnvelope(deadline, 'watchDeadline', 'watchDeadline', 'base32sha256', issues);
  identifier(deadline.watchRuleId, 'watchRule', 'uuidv7', 'watchRuleId', issues);
  nonEmpty(deadline.subjectKey, 'subjectKey', issues);
  wholeNumber(deadline.activityGeneration, 0, 'activityGeneration', issues);
  isoUtc(deadline.dueAt, 'dueAt', issues);
  oneOf(deadline.state, ['armed', 'claimed', 'fired', 'superseded'], 'state', issues);
  if (deadline.claimedByRuntimeEpochId !== undefined) {
    identifier(
      deadline.claimedByRuntimeEpochId,
      'runtimeEpoch',
      'uuidv7',
      'claimedByRuntimeEpochId',
      issues,
    );
  }
  if (deadline.lateByMs !== undefined) wholeNumber(deadline.lateByMs, 0, 'lateByMs', issues);
  if (deadline.driftState !== undefined) validateDurableDriftState(deadline.driftState, issues);
  if (context !== undefined) {
    const expectsDrift = context.conditionKind === 'activity-drift';
    if (expectsDrift !== (deadline.driftState !== undefined)) {
      issues.push({
        path: 'driftState',
        message: 'is required only for an activity-drift WatchRule',
      });
    }
  }
  return finish<WatchDeadline>(candidate, issues);
}

function zeroTurns(value: unknown, issues: ValidationIssue[]): void {
  exact(value, 0, 'providerTurnsStartedThisEvaluation', issues);
}

/** Runtime parser for every exact §12.7 DriftCheckOutcome branch. */
export function parseDriftCheckOutcome(candidate: unknown): B3Result<DriftCheckOutcome> {
  const issues: ValidationIssue[] = [];
  const outcome = objectValue(candidate, 'driftCheckOutcome', issues);
  zeroTurns(outcome.providerTurnsStartedThisEvaluation, issues);
  if (outcome.kind === 'healthy-free-evidence') {
    stringArray(outcome.evidenceRefs, 'evidenceRefs', issues);
  } else if (outcome.kind === 'first-quiet-interval') {
    exact(outcome.staleIntervals, 1, 'staleIntervals', issues);
  } else if (outcome.kind === 'status-turn-queued') {
    exact(outcome.staleIntervals, 2, 'staleIntervals', issues);
    identifier(outcome.notificationId, 'notification', 'base32sha256', 'notificationId', issues);
    nonEmpty(outcome.effectKey, 'effectKey', issues);
  } else if (outcome.kind === 'status-replied') {
    exact(outcome.consecutiveDrift, 0, 'consecutiveDrift', issues);
    nonEmpty(outcome.replyEvidenceRef, 'replyEvidenceRef', issues);
  } else if (outcome.kind === 'status-cancelled-before-delivery') {
    identifier(outcome.episodeId, 'driftEpisode', 'base32sha256', 'episodeId', issues);
    nonEmpty(outcome.movementEvidenceRef, 'movementEvidenceRef', issues);
  } else if (outcome.kind === 'status-still-unanswered') {
    oneOf(
      outcome.consecutiveUnansweredChecks,
      [1, 2],
      'consecutiveUnansweredChecks',
      issues,
    );
    nonEmpty(outcome.effectKey, 'effectKey', issues);
  } else if (outcome.kind === 'human-escalation-queued') {
    exact(outcome.consecutiveUnansweredChecks, 3, 'consecutiveUnansweredChecks', issues);
    identifier(outcome.notificationId, 'notification', 'base32sha256', 'notificationId', issues);
    exact(outcome.state, 'escalated-waiting-human', 'state', issues);
  } else {
    issues.push({ path: 'kind', message: 'is not a DriftCheckOutcome kind' });
  }
  return finish<DriftCheckOutcome>(candidate, issues);
}

function validateRunUsage(value: unknown, path: string, issues: ValidationIssue[]): void {
  const parsed = parseAgentRunUsage(value);
  if (!parsed.ok) issues.push({ path, message: parsed.error.message });
}

const USAGE_METRICS = [
  'inputTokens', 'outputTokens', 'cachedInputTokens', 'costMicros', 'providerTurns',
] as const satisfies readonly (keyof AgentUsageAggregate)[];

type UsageMetric = typeof USAGE_METRICS[number];

function expectedAggregateValue(
  runs: readonly AgentRunUsage[],
  metric: UsageMetric,
): UsageValue {
  if (runs.length === 0) {
    return { quality: 'unavailable', source: 'aggregate:runs', limitations: ['no-runs'] };
  }
  const values = runs.flatMap((run) => {
    const usage = run[metric];
    return usage.value === undefined ? [] : [usage.value];
  });
  const limitations = [...new Set(runs.flatMap((run) => [
    ...run[metric].limitations,
    ...(run[metric].value === undefined ? [String(run.agentRunId)] : []),
  ]))].sort();
  if (values.length === 0) {
    return { quality: 'unavailable', source: 'aggregate:runs', limitations };
  }
  const everySupplies = values.length === runs.length;
  const somePartialOrUnavailable = runs.some(
    (run) => run[metric].quality === 'partial' || run[metric].quality === 'unavailable',
  );
  const quality = runs.every((run) => run[metric].quality === 'measured')
    ? 'measured'
    : everySupplies && !somePartialOrUnavailable
      ? 'estimated'
      : somePartialOrUnavailable
        ? 'partial'
        : 'unavailable';
  return {
    quality,
    ...(quality === 'unavailable' ? {} : { value: values.reduce((sum, value) => sum + value, 0) }),
    source: 'aggregate:runs',
    limitations,
  };
}

function sameUsageValue(left: UsageValue, right: UsageValue): boolean {
  return left.quality === right.quality
    && left.value === right.value
    && left.source === right.source
    && left.limitations.length === right.limitations.length
    && left.limitations.every((value, index) => value === right.limitations[index]);
}

function validateAggregateSemantics(
  runs: readonly AgentRunUsage[],
  aggregate: AgentUsageAggregate,
  issues: ValidationIssue[],
): void {
  const ordered = runs.every(
    (run, index) => index === 0 || String(runs[index - 1]!.agentRunId) < String(run.agentRunId),
  );
  if (!ordered) issues.push({ path: 'runs', message: 'must be ordered by agentRunId' });
  for (const metric of USAGE_METRICS) {
    if (!sameUsageValue(aggregate[metric], expectedAggregateValue(runs, metric))) {
      issues.push({ path: `aggregate.${metric}`, message: 'does not match the ruled runs aggregate' });
    }
  }
  if (aggregate.final !== runs.every((run) => run.final)) {
    issues.push({ path: 'aggregate.final', message: 'must be true exactly when every run is final' });
  }
  if (runs.length > 0) {
    const latest = runs.reduce(
      (value, run) => String(run.observedAt) > String(value) ? run.observedAt : value,
      runs[0]!.observedAt,
    );
    if (aggregate.observedAt !== latest) {
      issues.push({ path: 'aggregate.observedAt', message: 'must be the latest run observation' });
    }
  }
}

/** Runtime parser for the exact §12.7 AgentUsageSummary output shape. */
export function parseAgentUsageSummary(candidate: unknown): B3Result<AgentUsageSummary> {
  const issues: ValidationIssue[] = [];
  const summary = objectValue(candidate, 'agentUsageSummary', issues);
  identifier(summary.agentId, 'agent', 'uuidv4', 'agentId', issues);
  const runs: AgentRunUsage[] = [];
  if (!Array.isArray(summary.runs)) {
    issues.push({ path: 'runs', message: 'must be an array' });
  } else {
    summary.runs.forEach((runUsage, index) => {
      const parsed = parseAgentRunUsage(runUsage);
      if (parsed.ok) runs.push(parsed.value);
      else issues.push({ path: `runs.${index}`, message: parsed.error.message });
    });
  }
  const aggregate = parseAgentUsageAggregate(summary.aggregate);
  if (aggregate.ok) validateAggregateSemantics(runs, aggregate.value, issues);
  else issues.push({ path: 'aggregate', message: aggregate.error.message });
  return finish<AgentUsageSummary>(candidate, issues);
}
