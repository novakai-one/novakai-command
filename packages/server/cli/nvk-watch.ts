#!/usr/bin/env -S npx tsx
// nvk-watch — create and inspect durable watcher rules (§17.1).
//
//   nvk watch add            create one active watcher rule
//   nvk watch list           the standing watcher rules and their deadlines
//   nvk watch notifications  the durable Notification queue
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  b3err, b3fail, b3ok, isValidId, validationFailed,
  type B3Result,
} from '@novakai/foundation/contract';
import type {
  DriftCheckPolicy, Notification, WatchCondition, WatchDeadline, WatchRule, WatchSubject,
} from '../../supervision/contract/index.js';
import { ACTIVITY_DRIFT_TEMPLATE } from '../../supervision/contract/index.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import {
  clientOpIdFrom, emit, parseFlags, type Flags,
} from '../core/b3/cli-shared.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const [, , command = 'list', ...rest] = process.argv;
const flags = parseFlags(rest);
const root = flags.value('root') ?? process.env['NOVAKAI_ROOT'] ?? path.join(repoRoot, '.novakai');
const port = Number(flags.value('port') ?? process.env['NOVAKAI_RUNTIME_PORT'] ?? 5190);

const unreachable = (cause: unknown): ReturnType<typeof b3err> => b3err('RuntimeUnavailable',
  `no Novakai Runtime is reachable on port ${String(port)}: ${
    cause instanceof Error ? cause.message : String(cause)}`,
  { reason: 'not-reachable' }, true);

async function withClient<Value>(
  work: (client: RuntimeClient) => Promise<B3Result<Value>>,
): Promise<B3Result<Value>> {
  let client: RuntimeClient;
  try {
    client = await connectRuntime({ root, port });
  } catch (cause) {
    return b3fail(unreachable(cause));
  }
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

interface WatcherListing {
  readonly rules: readonly WatchRule[];
  readonly deadlines: readonly WatchDeadline[];
}

function describeWatchers(listing: WatcherListing): string {
  if (listing.rules.length === 0) return 'Nothing is being watched.';
  const dueOf = (rule: WatchRule): string => {
    const deadline = listing.deadlines
      .filter((item) => item.watchRuleId === rule.id)
      .sort((left, right) => Number(right.activityGeneration) - Number(left.activityGeneration))[0];
    return deadline === undefined ? 'no deadline' : `${deadline.state} until ${deadline.dueAt}`;
  };
  return listing.rules.map((rule) => `${rule.condition.kind}  ${rule.status}  ${rule.id}\n`
    + `  ${JSON.stringify(rule.subject)} · ${rule.deliveryMode} · ${dueOf(rule)}`).join('\n');
}

function describeNotifications(page: { readonly items: readonly Notification[] }): string {
  if (page.items.length === 0) return 'Nothing is queued.';
  return page.items.map((item) => `${item.state}  ${item.summary}\n`
    + `  ${item.id} · ${item.phase} · ${item.deliveryMode}`).join('\n');
}

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

function addInput(argFlags: Flags): B3Result<Readonly<Record<string, unknown>>> {
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

const ADD_COMMAND = 'add';
const UPDATE_COMMAND = 'update';

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

function replacementInput(
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

async function currentRule(
  client: RuntimeClient,
  watchRuleId: string | undefined,
): Promise<B3Result<WatchRule>> {
  if (watchRuleId === undefined || !isValidId(watchRuleId, 'watchRule', 'uuidv7')) {
    return b3fail(validationFailed([{
      path: 'watchRuleId', message: 'must be a WatchRuleId positional argument',
    }]));
  }
  const listed = await client.call<WatcherListing>(
    'b3.supervision.listWatchers', { limit: 500 },
  );
  if (!listed.ok) return listed;
  const found = listed.value.rules.find((rule) => rule.id === watchRuleId);
  return found === undefined
    ? b3fail(b3err('WatcherConflict', 'the WatchRule does not exist', { watchRuleId }, true))
    : b3ok(found);
}

const COMMANDS: Record<string, (argFlags: Flags) => Promise<never>> = {
  [ADD_COMMAND]: async function addWatcher(argFlags) {
    const input = addInput(argFlags);
    if (!input.ok) emit('watch add', argFlags, input, () => '');
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch add', argFlags, clientOpId, () => '');
    emit('watch add', argFlags, await withClient<WatchRule>(
      (client) => client.call(
        'b3.supervision.createWatch', input.value, clientOpId.value,
      ),
    ), (rule) => `Watching ${JSON.stringify(rule.subject)} for ${rule.condition.kind}.`);
  },

  [UPDATE_COMMAND]: async function updateWatcher(argFlags) {
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch update', argFlags, clientOpId, () => '');
    emit('watch update', argFlags, await withClient<WatchRule>(async (client) => {
      const current = await currentRule(client, argFlags.positional[0]);
      if (!current.ok) return current;
      const replacement = replacementInput(current.value, argFlags);
      if (!replacement.ok) return replacement;
      return client.call('b3.supervision.updateWatch', {
        watchRuleId: current.value.id,
        expectedRecordVersion: current.value.recordVersion,
        replacement: replacement.value,
      }, clientOpId.value);
    }), (rule) => `Updated ${rule.id} to record version ${String(rule.recordVersion)}.`);
  },

  async list(argFlags) {
    const limit = Number(argFlags.value('limit') ?? 50);
    emit('watch list', argFlags, await withClient<WatcherListing>(
      (client) => client.call('b3.supervision.listWatchers', { limit }),
    ), describeWatchers);
  },

  async notifications(argFlags) {
    const limit = Number(argFlags.value('limit') ?? 50);
    emit('watch notifications', argFlags, await withClient<{
      readonly items: readonly Notification[];
    }>((client) => client.call('b3.supervision.listNotifications', { limit })),
    describeNotifications);
  },
};

const chosen = COMMANDS[command];
if (chosen === undefined) {
  process.stderr.write(`${JSON.stringify({
    code: 'Usage',
    message: `usage: nvk watch ${Object.keys(COMMANDS).join('|')} [options] [--json]`,
  })}\n`);
  process.exitCode = 2;
} else {
  await chosen(flags);
}
