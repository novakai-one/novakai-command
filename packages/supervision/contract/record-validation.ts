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
  WatchCondition,
  WatchDeadline,
  WatchRule,
} from './records.js';
import { parseAgentRunUsage, parseCreateWatchRuleInput } from './validation.js';
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

/** Runtime parser for the exact §12.7 AgentUsageSummary output shape. */
export function parseAgentUsageSummary(candidate: unknown): B3Result<AgentUsageSummary> {
  const issues: ValidationIssue[] = [];
  const summary = objectValue(candidate, 'agentUsageSummary', issues);
  identifier(summary.agentId, 'agent', 'uuidv4', 'agentId', issues);
  if (!Array.isArray(summary.runs)) {
    issues.push({ path: 'runs', message: 'must be an array' });
  } else {
    summary.runs.forEach((runUsage, index) => {
      validateRunUsage(runUsage, `runs.${index}`, issues);
    });
  }
  validateRunUsage(summary.aggregate, 'aggregate', issues);
  return finish<AgentUsageSummary>(candidate, issues);
}
