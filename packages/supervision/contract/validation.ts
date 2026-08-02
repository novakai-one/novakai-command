import {
  b3fail,
  b3err,
  b3ok,
  isValidId,
  validationFailed,
  type AgentId,
  type AgentRunId,
  type B3Result,
  type IsoUtc,
} from '@novakai/foundation/contract';
import type { HumanPrincipalId } from './shared.js';
import {
  DRIFT_FREE_EVIDENCE,
  DRIFT_STATUS_PROMPT,
} from './drift.js';
import type { CreateWatchRuleInput } from './api.js';
import type {
  DriftCheckPolicy,
  FutureOperationAction,
  AgentUsageAggregate,
  AgentRunUsage,
  MeasurementQuality,
  NotificationRecipient,
  UsageValue,
  WatchCondition,
  WatchSubject,
} from './records.js';

interface Issue {
  readonly path: string;
  readonly message: string;
}

type ObjectValue = Readonly<Record<string, unknown>>;

const objectValue = (value: unknown, path: string, issues: Issue[]): ObjectValue => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return {};
  }
  return value as ObjectValue;
};

const choice = <Value extends string>(
  value: unknown, allowed: readonly Value[], path: string, issues: Issue[],
): Value => {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    issues.push({ path, message: `must be one of: ${allowed.join(', ')}` });
    return allowed[0]!;
  }
  return value as Value;
};

const integer = (
  value: unknown, least: number, most: number, path: string, issues: Issue[],
): number => {
  if (!Number.isInteger(value) || (value as number) < least || (value as number) > most) {
    issues.push({ path, message: `must be a whole number between ${least} and ${most}` });
    return least;
  }
  return value as number;
};

const nonEmpty = (value: unknown, path: string, issues: Issue[]): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'must be a non-empty string' });
    return '';
  }
  return value;
};

function readSubject(value: unknown, issues: Issue[]): WatchSubject {
  const subject = objectValue(value, 'subject', issues);
  const kind = choice(subject.kind, ['agent', 'agent-run', 'children-of'], 'subject.kind', issues);
  if (kind === 'agent-run') {
    const id = subject.agentRunId;
    if (!isValidId(id, 'agentRun', 'uuidv7')) {
      issues.push({ path: 'subject.agentRunId', message: 'must be an agentRun identifier' });
    }
    return { kind, agentRunId: id as AgentRunId };
  }
  const id = subject.agentId;
  if (!isValidId(id, 'agent', 'uuidv4')) {
    issues.push({ path: 'subject.agentId', message: 'must be an agent identifier' });
  }
  return { kind, agentId: id as AgentId };
}

function readCondition(value: unknown, issues: Issue[]): WatchCondition {
  const condition = objectValue(value, 'condition', issues);
  const kind = choice(condition.kind, [
    'turn-count-at-least', 'input-tokens-at-least', 'output-tokens-at-least',
    'cost-micros-at-least', 'idle-for-ms', 'activity-drift', 'run-disconnected',
    'run-final', 'child-needs-help', 'operation-failed',
  ], 'condition.kind', issues);
  if (kind === 'activity-drift') {
    return {
      kind,
      intervalMs: integer(condition.intervalMs, 300_000, 600_000, 'condition.intervalMs', issues),
      staleAfterIntervals: integer(
        condition.staleAfterIntervals, 2, 2, 'condition.staleAfterIntervals', issues,
      ) as 2,
      escalateAfterConsecutive: integer(
        condition.escalateAfterConsecutive, 3, 3, 'condition.escalateAfterConsecutive', issues,
      ) as 3,
    };
  }
  if (kind === 'turn-count-at-least'
    || kind === 'input-tokens-at-least'
    || kind === 'output-tokens-at-least'
    || kind === 'cost-micros-at-least'
    || kind === 'idle-for-ms') {
    return { kind, value: integer(condition.value, 0, Number.MAX_SAFE_INTEGER, 'condition.value', issues) };
  }
  return { kind };
}

function readRecipient(value: unknown, issues: Issue[]): NotificationRecipient {
  const recipient = objectValue(value, 'recipient', issues);
  const kind = choice(recipient.kind, ['agent', 'human'], 'recipient.kind', issues);
  if (kind === 'agent') {
    if (!isValidId(recipient.agentId, 'agent', 'uuidv4')) {
      issues.push({ path: 'recipient.agentId', message: 'must be an agent identifier' });
    }
    return { kind, agentId: recipient.agentId as AgentId };
  }
  const principalId = nonEmpty(recipient.principalId, 'recipient.principalId', issues);
  if (!/^person_[A-Za-z0-9-]+$/.test(principalId)) {
    issues.push({ path: 'recipient.principalId', message: 'must be a Messaging PersonId' });
  }
  return {
    kind,
    principalId: principalId as HumanPrincipalId,
  };
}

function readDriftPolicy(value: unknown, issues: Issue[]): DriftCheckPolicy {
  const policy = objectValue(value, 'driftPolicy', issues);
  const evidence = policy.freeEvidence;
  if (!Array.isArray(evidence) || evidence.length !== 3
    || evidence.some((item, index) => item !== DRIFT_FREE_EVIDENCE[index])) {
    issues.push({ path: 'driftPolicy.freeEvidence', message: 'must be the canonical cheap-first tuple' });
  }
  return {
    mode: choice(policy.mode, ['cheap-first'], 'driftPolicy.mode', issues),
    freeEvidence: DRIFT_FREE_EVIDENCE,
    statusTurn: choice(policy.statusTurn, [
      'queue-runtime-status-request-only-after-free-evidence-suspicious',
    ], 'driftPolicy.statusTurn', issues),
    statusRecipient: choice(
      policy.statusRecipient, ['subject-agent'], 'driftPolicy.statusRecipient', issues,
    ),
    statusDeliveryMode: choice(
      policy.statusDeliveryMode, ['start-turn'], 'driftPolicy.statusDeliveryMode', issues,
    ),
    replyWindowMs: integer(
      policy.replyWindowMs, 300_000, 600_000, 'driftPolicy.replyWindowMs', issues,
    ),
    statusPrompt: choice(policy.statusPrompt, [DRIFT_STATUS_PROMPT], 'driftPolicy.statusPrompt', issues),
  };
}

function readAction(value: unknown, issues: Issue[]): FutureOperationAction {
  const action = objectValue(value, 'action', issues);
  return {
    operationDefinitionId: nonEmpty(
      action.operationDefinitionId, 'action.operationDefinitionId', issues,
    ),
    contractVersion: integer(action.contractVersion, 1, 1, 'action.contractVersion', issues) as 1,
    status: choice(action.status, [
      'reserved-not-executable-in-build3',
    ], 'action.status', issues),
  };
}

/** Runtime parser for the public create-WatchRule boundary (§4.2, §24.1). */
export function parseCreateWatchRuleInput(candidate: unknown): B3Result<CreateWatchRuleInput> {
  const issues: Issue[] = [];
  const input = objectValue(candidate, 'payload', issues);
  const condition = readCondition(input.condition, issues);
  const hasDriftPolicy = input.driftPolicy !== undefined;
  if ((condition.kind === 'activity-drift') !== hasDriftPolicy) {
    issues.push({
      path: 'driftPolicy',
      message: 'is required only when condition.kind is activity-drift',
    });
  }
  const parsed: CreateWatchRuleInput = {
    subject: readSubject(input.subject, issues),
    condition,
    recipient: readRecipient(input.recipient, issues),
    deliveryMode: choice(
      input.deliveryMode, ['queue-only', 'next-turn-context', 'start-turn'],
      'deliveryMode', issues,
    ),
    cooldownMs: integer(input.cooldownMs, 0, Number.MAX_SAFE_INTEGER, 'cooldownMs', issues),
    status: choice(input.status, ['active', 'paused', 'retired'], 'status', issues),
    ...(hasDriftPolicy ? { driftPolicy: readDriftPolicy(input.driftPolicy, issues) } : {}),
    ...(input.action === undefined ? {} : { action: readAction(input.action, issues) }),
  };
  return issues.length === 0
    ? b3ok(parsed)
    : b3fail(driftRangeError(issues));
}

function driftRangeError(issues: readonly Issue[]) {
  const rangePaths = new Set(['condition.intervalMs', 'driftPolicy.replyWindowMs']);
  if (issues.some((issue) => rangePaths.has(issue.path))) {
    return b3err(
      'WatchRuleInvalid',
      'activity-drift timing must be between 300000 and 600000 milliseconds',
      { issues },
      false,
    );
  }
  return validationFailed(issues);
}

function stringArray(value: unknown, path: string, issues: Issue[]): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issues.push({ path, message: 'must be an array of strings' });
    return [];
  }
  return value;
}

function readUsageValue(value: unknown, path: string, issues: Issue[]): UsageValue {
  const usage = objectValue(value, path, issues);
  const rawValue = usage.value;
  if (rawValue !== undefined
    && (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue < 0)) {
    issues.push({ path: `${path}.value`, message: 'must be a non-negative finite number' });
  }
  if (usage.quality === 'unavailable' && rawValue !== undefined) {
    issues.push({ path: `${path}.value`, message: 'must be absent when quality is unavailable' });
  }
  return {
    quality: choice<MeasurementQuality>(usage.quality, [
      'measured', 'estimated', 'partial', 'unavailable',
    ], `${path}.quality`, issues),
    ...(rawValue === undefined ? {} : { value: rawValue as number }),
    source: nonEmpty(usage.source, `${path}.source`, issues),
    limitations: stringArray(usage.limitations, `${path}.limitations`, issues),
  };
}

function readIsoUtc(value: unknown, path: string, issues: Issue[]): IsoUtc {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    issues.push({ path, message: 'must be an ISO-8601 UTC timestamp' });
    return '' as IsoUtc;
  }
  return value as IsoUtc;
}

/** Runtime parser for the rebuildable per-Run usage projection (§9.1). */
export function parseAgentRunUsage(candidate: unknown): B3Result<AgentRunUsage> {
  const issues: Issue[] = [];
  const usage = objectValue(candidate, 'payload', issues);
  if (!isValidId(usage.agentRunId, 'agentRun', 'uuidv7')) {
    issues.push({ path: 'agentRunId', message: 'must be an agentRun identifier' });
  }
  if (typeof usage.final !== 'boolean') {
    issues.push({ path: 'final', message: 'must be a boolean' });
  }
  const parsed: AgentRunUsage = {
    agentRunId: usage.agentRunId as AgentRunId,
    inputTokens: readUsageValue(usage.inputTokens, 'inputTokens', issues),
    outputTokens: readUsageValue(usage.outputTokens, 'outputTokens', issues),
    cachedInputTokens: readUsageValue(usage.cachedInputTokens, 'cachedInputTokens', issues),
    costMicros: readUsageValue(usage.costMicros, 'costMicros', issues),
    providerTurns: readUsageValue(usage.providerTurns, 'providerTurns', issues),
    observedAt: readIsoUtc(usage.observedAt, 'observedAt', issues),
    final: usage.final as boolean,
  };
  return issues.length === 0
    ? b3ok(parsed)
    : b3fail(validationFailed(issues));
}

/** Runtime parser for an Agent aggregate, which deliberately has no Run identity. */
export function parseAgentUsageAggregate(candidate: unknown): B3Result<AgentUsageAggregate> {
  const issues: Issue[] = [];
  const usage = objectValue(candidate, 'aggregate', issues);
  if (usage.agentRunId !== undefined) {
    issues.push({ path: 'aggregate.agentRunId', message: 'must be absent on an Agent aggregate' });
  }
  if (typeof usage.final !== 'boolean') {
    issues.push({ path: 'aggregate.final', message: 'must be a boolean' });
  }
  const parsed: AgentUsageAggregate = {
    inputTokens: readUsageValue(usage.inputTokens, 'aggregate.inputTokens', issues),
    outputTokens: readUsageValue(usage.outputTokens, 'aggregate.outputTokens', issues),
    cachedInputTokens: readUsageValue(
      usage.cachedInputTokens, 'aggregate.cachedInputTokens', issues,
    ),
    costMicros: readUsageValue(usage.costMicros, 'aggregate.costMicros', issues),
    providerTurns: readUsageValue(usage.providerTurns, 'aggregate.providerTurns', issues),
    observedAt: readIsoUtc(usage.observedAt, 'aggregate.observedAt', issues),
    final: usage.final as boolean,
  };
  return issues.length === 0 ? b3ok(parsed) : b3fail(validationFailed(issues));
}
