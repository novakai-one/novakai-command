import {
  b3fail, b3ok, isValidId, validationFailed,
  type B3Result,
} from '@novakai/foundation/contract';
import {
  ACTIVITY_DRIFT_TEMPLATE,
  type DriftCheckPolicy,
  type WatchCondition,
  type WatchRule,
  type WatchSubject,
} from '../../supervision/contract/index.js';
import type { Flags } from '../core/b3/cli-shared.js';

const missingFlag = (name: string): B3Result<never> => b3fail(validationFailed([{
  path: name,
  message: `--${name} is required`,
}]));

function parseSubject(value: string | undefined): B3Result<WatchSubject> {
  if (value === undefined) return missingFlag('subject');
  if (value.startsWith('children:')) {
    const agentId = value.slice('children:'.length);
    return isValidId(agentId, 'agent', 'uuidv4')
      ? b3ok({ kind: 'children-of', agentId: agentId as never })
      : b3fail(validationFailed([{ path: 'subject', message: 'has an invalid AgentId' }]));
  }
  if (isValidId(value, 'agentRun', 'uuidv7')) {
    return b3ok({ kind: 'agent-run', agentRunId: value as never });
  }
  if (isValidId(value, 'agent', 'uuidv4')) {
    return b3ok({ kind: 'agent', agentId: value as never });
  }
  return b3fail(validationFailed([{
    path: 'subject',
    message: 'must be an AgentId, AgentRunId, or children:<AgentId>',
  }]));
}

interface ParsedCondition {
  readonly condition: WatchCondition;
  readonly driftPolicy?: DriftCheckPolicy;
}

const NUMERIC_CONDITIONS = new Set<WatchCondition['kind']>([
  'turn-count-at-least', 'input-tokens-at-least', 'output-tokens-at-least',
  'cost-micros-at-least', 'idle-for-ms',
]);
const EVENT_CONDITIONS = new Set<WatchCondition['kind']>([
  'run-disconnected', 'run-final', 'child-needs-help', 'operation-failed',
]);

function parseConditionJson(value: string): B3Result<ParsedCondition> {
  try {
    return b3ok({ condition: JSON.parse(value) as WatchCondition });
  } catch {
    return b3fail(validationFailed([{
      path: 'when', message: 'must be a WatchCondition JSON object or kind[:value]',
    }]));
  }
}

function parseCondition(value: string | undefined): B3Result<ParsedCondition> {
  if (value === undefined) return missingFlag('when');
  if (value.startsWith('{')) return parseConditionJson(value);
  if (value === 'activity-drift') {
    return b3ok({
      condition: ACTIVITY_DRIFT_TEMPLATE.condition,
      driftPolicy: ACTIVITY_DRIFT_TEMPLATE.driftPolicy,
    });
  }
  const separator = value.indexOf(':');
  const kind = separator === -1 ? value : value.slice(0, separator);
  const scalar = separator === -1 ? undefined : Number(value.slice(separator + 1));
  if (NUMERIC_CONDITIONS.has(kind as WatchCondition['kind'])
    && scalar !== undefined && Number.isInteger(scalar) && scalar >= 0) {
    return b3ok({ condition: { kind, value: scalar } as WatchCondition });
  }
  if (EVENT_CONDITIONS.has(kind as WatchCondition['kind']) && scalar === undefined) {
    return b3ok({ condition: { kind } as WatchCondition });
  }
  return b3fail(validationFailed([{
    path: 'when', message: 'must be an event kind, activity-drift, or numeric kind:value',
  }]));
}

function parseRecipient(value: string | undefined): B3Result<unknown> {
  if (value === undefined) return missingFlag('notify');
  if (value === 'human') return b3ok('authenticated-human');
  return isValidId(value, 'agent', 'uuidv4')
    ? b3ok({ kind: 'agent', agentId: value })
    : b3fail(validationFailed([{
      path: 'notify', message: 'must be human or an AgentId',
    }]));
}

export function addWatchInput(argFlags: Flags): B3Result<Readonly<Record<string, unknown>>> {
  const subject = parseSubject(argFlags.value('subject'));
  if (!subject.ok) return subject;
  const condition = parseCondition(argFlags.value('when'));
  if (!condition.ok) return condition;
  const recipient = parseRecipient(argFlags.value('notify'));
  if (!recipient.ok) return recipient;
  const deliveryMode = argFlags.value('delivery');
  if (!['queue-only', 'next-turn-context', 'start-turn'].includes(deliveryMode ?? '')) {
    return b3fail(validationFailed([{
      path: 'delivery',
      message: 'must be queue-only, next-turn-context, or start-turn',
    }]));
  }
  return b3ok({
    subject: subject.value,
    condition: condition.value.condition,
    recipient: recipient.value,
    deliveryMode,
    cooldownMs: 0,
    status: 'active',
    ...(condition.value.driftPolicy === undefined
      ? {}
      : { driftPolicy: condition.value.driftPolicy }),
  });
}

interface ReplacementIdentityFields {
  readonly subject: WatchSubject;
  readonly condition: ParsedCondition;
  readonly recipient: unknown;
}

function replacementIdentityFields(
  current: WatchRule,
  argFlags: Flags,
): B3Result<ReplacementIdentityFields> {
  const parsedSubject = argFlags.value('subject') === undefined
    ? b3ok(current.subject)
    : parseSubject(argFlags.value('subject'));
  if (!parsedSubject.ok) return parsedSubject;
  const parsedCondition = argFlags.value('when') === undefined
    ? b3ok({ condition: current.condition, driftPolicy: current.driftPolicy })
    : parseCondition(argFlags.value('when'));
  if (!parsedCondition.ok) return parsedCondition;
  const parsedRecipient = argFlags.value('notify') === undefined
    ? b3ok(current.recipient)
    : parseRecipient(argFlags.value('notify'));
  return parsedRecipient.ok
    ? b3ok({
      subject: parsedSubject.value,
      condition: parsedCondition.value,
      recipient: parsedRecipient.value,
    })
    : parsedRecipient;
}

export function replacementWatchInput(
  current: WatchRule,
  argFlags: Flags,
): B3Result<Readonly<Record<string, unknown>>> {
  const identity = replacementIdentityFields(current, argFlags);
  if (!identity.ok) return identity;
  const deliveryMode = argFlags.value('delivery') ?? current.deliveryMode;
  if (!['queue-only', 'next-turn-context', 'start-turn'].includes(deliveryMode)) {
    return b3fail(validationFailed([{
      path: 'delivery', message: 'must be queue-only, next-turn-context, or start-turn',
    }]));
  }
  const status = argFlags.value('status') ?? current.status;
  if (!['active', 'paused', 'retired'].includes(status)) {
    return b3fail(validationFailed([{
      path: 'status', message: 'must be active, paused, or retired',
    }]));
  }
  const cooldownMs = Number(argFlags.value('cooldown-ms') ?? current.cooldownMs);
  if (!Number.isInteger(cooldownMs) || cooldownMs < 0) {
    return b3fail(validationFailed([{
      path: 'cooldown-ms', message: 'must be a non-negative whole number',
    }]));
  }
  return b3ok({
    subject: identity.value.subject,
    condition: identity.value.condition.condition,
    recipient: identity.value.recipient,
    deliveryMode,
    cooldownMs,
    status,
    ...(identity.value.condition.driftPolicy === undefined
      ? {}
      : { driftPolicy: identity.value.condition.driftPolicy }),
    ...(current.action === undefined ? {} : { action: current.action }),
  });
}
