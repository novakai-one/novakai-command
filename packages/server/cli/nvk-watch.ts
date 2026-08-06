#!/usr/bin/env -S npx tsx
// nvk-watch — create and inspect durable watcher rules (§17.1).
//
//   nvk watch add            create one active watcher rule
//   nvk watch list           the standing watcher rules and their deadlines
//   nvk watch notifications  the durable Notification queue
//   nvk watch acknowledge    settle one Notification you have actually seen
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  b3err, b3fail, b3ok, isValidId, validationFailed,
  type B3Result,
} from '@novakai/foundation/contract';
import type {
  Notification, WatchDeadline, WatchRule,
} from '../../supervision/contract/index.js';
import { watchRemoveRetirement } from '../../supervision/contract/index.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import {
  clientOpIdFrom, emit, fail, pageFlags, parseFlags, type Flags,
} from '../core/b3/cli-shared.js';
import { addWatchInput, replacementWatchInput } from './nvk-watch-inputs.js';

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
    return deadline === undefined
      ? 'no deadline'
      : `${deadline.id} · ${deadline.state} until ${deadline.dueAt}`;
  };
  return listing.rules.map((rule) => `${rule.condition.kind}  ${rule.status}  ${rule.id}\n`
    + `  ${JSON.stringify(rule.subject)} · ${rule.deliveryMode} · ${dueOf(rule)}`).join('\n');
}

function describeNotifications(page: { readonly items: readonly Notification[] }): string {
  if (page.items.length === 0) return 'Nothing is queued.';
  return page.items.map((item) => `${item.state}  ${item.summary}\n`
    + `  ${item.id} · ${item.phase} · ${item.deliveryMode}`).join('\n');
}

const ADD_COMMAND = 'add';
const UPDATE_COMMAND = 'update';
const REMOVE_COMMAND = 'remove';
const RESET_DRIFT_COMMAND = 'reset-drift';

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

async function currentDeadline(
  client: RuntimeClient,
  watchDeadlineId: string | undefined,
): Promise<B3Result<WatchDeadline>> {
  if (watchDeadlineId === undefined
    || !isValidId(watchDeadlineId, 'watchDeadline', 'base32sha256')) {
    return b3fail(validationFailed([{
      path: 'watchDeadlineId', message: 'must be a WatchDeadlineId positional argument',
    }]));
  }
  const listed = await client.call<WatcherListing>(
    'b3.supervision.listWatchers', { limit: 500 },
  );
  if (!listed.ok) return listed;
  const found = listed.value.deadlines.find((deadline) => deadline.id === watchDeadlineId);
  return found === undefined
    ? b3fail(b3err(
      'WatcherConflict', 'the current WatchDeadline does not exist', { watchDeadlineId }, true,
    ))
    : b3ok(found);
}

function describeAcknowledgement(item: Notification): string {
  return `${item.state}  ${item.summary}\n  ${item.id}`;
}

const COMMANDS: Record<string, (argFlags: Flags) => Promise<never>> = {
  [ADD_COMMAND]: async function addWatcher(argFlags) {
    const input = addWatchInput(argFlags);
    if (!input.ok) emit('watch.add', argFlags, input, () => '');
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch.add', argFlags, clientOpId, () => '');
    emit('watch.add', argFlags, await withClient<WatchRule>(
      (client) => client.call(
        'b3.supervision.createWatch', input.value, clientOpId.value,
      ),
    ), (rule) => `Watching ${JSON.stringify(rule.subject)} for ${rule.condition.kind}.`);
  },

  [UPDATE_COMMAND]: async function updateWatcher(argFlags) {
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch.update', argFlags, clientOpId, () => '');
    emit('watch.update', argFlags, await withClient<WatchRule>(async (client) => {
      const current = await currentRule(client, argFlags.positional[0]);
      if (!current.ok) return current;
      const replacement = replacementWatchInput(current.value, argFlags);
      if (!replacement.ok) return replacement;
      return client.call('b3.supervision.updateWatch', {
        watchRuleId: current.value.id,
        expectedRecordVersion: current.value.recordVersion,
        replacement: replacement.value,
      }, clientOpId.value);
    }), (rule) => `Updated ${rule.id} to record version ${String(rule.recordVersion)}.`);
  },

  [REMOVE_COMMAND]: async function removeWatcher(argFlags) {
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch.remove', argFlags, clientOpId, () => '');
    emit('watch.remove', argFlags, await withClient<WatchRule>(async (client) => {
      const current = await currentRule(client, argFlags.positional[0]);
      if (!current.ok) return current;
      return client.call(
        'b3.supervision.updateWatch',
        watchRemoveRetirement(current.value) as unknown as Readonly<Record<string, unknown>>,
        clientOpId.value,
      );
    }), (rule) => `Retired ${rule.id}.`);
  },

  [RESET_DRIFT_COMMAND]: async function resetDrift(argFlags) {
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch.reset-drift', argFlags, clientOpId, () => '');
    emit('watch.reset-drift', argFlags, await withClient<WatchDeadline>(async (client) => {
      const deadline = await currentDeadline(client, argFlags.positional[0]);
      if (!deadline.ok) return deadline;
      return client.call('b3.supervision.resetDrift', {
        watchDeadlineId: deadline.value.id,
        expectedRecordVersion: deadline.value.recordVersion,
        expectedEpisodeId: argFlags.value('episode'),
        reason: argFlags.value('reason') ?? 'reset requested by nvk watch reset-drift',
      }, clientOpId.value);
    }), (deadline) => `Reset drift deadline ${deadline.id}.`);
  },

  // A5-01: `--limit`/`--cursor` are the published page flags, spelled ONCE in
  // `pageFlags` and handed to the list method unchanged. This command used to
  // spell its own `Number(--limit ?? 50)` — a second default for the same law,
  // no validation (so `--limit abc` sent NaN), and no way to ask for page two
  // of a listing whose owner has always minted cursors.
  async list(argFlags) {
    const page = pageFlags(argFlags);
    if (!page.ok) return fail('watch.list', argFlags, page.error);
    emit('watch.list', argFlags, await withClient<WatcherListing>(
      (client) => client.call('b3.supervision.listWatchers', page.value),
    ), describeWatchers);
  },

  async notifications(argFlags) {
    const page = pageFlags(argFlags);
    if (!page.ok) return fail('watch.notifications', argFlags, page.error);
    emit('watch.notifications', argFlags, await withClient<{
      readonly items: readonly Notification[];
    }>((client) => client.call('b3.supervision.listNotifications', page.value)),
    describeNotifications);
  },

  async acknowledge(argFlags) {
    // Positional first, so `nvk watch acknowledge <id>` reads the way §17.1
    // writes it; --id stays available for scripts that would rather be explicit.
    const notificationId = argFlags.value('id') ?? rest[0];
    if (notificationId === undefined || notificationId.startsWith('--')) {
      emit('watch.acknowledge', argFlags, b3fail(b3err('ValidationFailed',
        'usage: nvk watch acknowledge <notificationId>',
        { issues: [{ path: 'notificationId', message: 'is required' }] }, false)),
      describeAcknowledgement);
    }
    emit('watch.acknowledge', argFlags, await withClient<Notification>(
      (client) => client.call('b3.supervision.acknowledge', { notificationId }),
    ), describeAcknowledgement);
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
