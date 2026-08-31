#!/usr/bin/env -S npx tsx
// nvk-watch — create and inspect durable watcher rules (§17.1).
//
//   nvk watch add            create one active watcher rule
//   nvk watch list           the standing watcher rules and their deadlines
//   nvk watch notifications  the durable Notification queue
//   nvk watch acknowledge    settle one Notification you have actually seen
//   nvk watch update <watchRuleId> --expect-version <n> [field flags]
//   nvk watch remove <watchRuleId> --expect-version <n>
//   nvk watch reset-drift <watchDeadlineId> --expect-version <n>
//                         --expect-episode <driftEpisodeId> --reason <text>
//
// A5-02: the preconditions above are the operator's to state. They used to be
// read from the record about to be written, which is a CAS that cannot refuse
// the race it exists for.
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
import { connectRuntime, type RuntimeClient } from '../core/runtime-host/client.js';
import {
  clientOpIdFrom, emit, expectedEpisode, expectedVersion, fail, pageFlags, parseFlags,
  requiredReason, type Flags,
} from '../core/runtime-host/cli-shared.js';
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

// `currentDeadline` lived here: it listed every watcher, found the deadline the
// operator had just named, and quoted its version back at the owner as the CAS
// precondition. A5-02 makes that version the operator's to state, and once it
// is stated there is nothing left for the lookup to find — the positional IS
// the WatchDeadlineId. Deleted rather than left unused; a `listWatchers` call
// on the way to a reset is a page of 500 rules fetched to learn nothing.

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

  /**
   * A5-02. `expectedRecordVersion` is the operator's now, not the CLI's.
   *
   * The rule is still READ — `updateWatch` replaces a WatchRule whole, so the
   * fields the operator did not restate have to come from somewhere. That read
   * composes the replacement BODY and supplies no precondition, which is the
   * distinction the amendment draws. It is safe precisely because the CAS is
   * now honest: if the record moved between this read and the write, the
   * operator's version no longer matches and the owner refuses the write —
   * so a body composed from a record the operator never saw can never land.
   */
  [UPDATE_COMMAND]: async function updateWatcher(argFlags) {
    const expected = expectedVersion(argFlags);
    if (!expected.ok) return fail('watch.update', argFlags, expected.error);
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch.update', argFlags, clientOpId, () => '');
    emit('watch.update', argFlags, await withClient<WatchRule>(async (client) => {
      const current = await currentRule(client, argFlags.positional[0]);
      if (!current.ok) return current;
      const replacement = replacementWatchInput(current.value, argFlags);
      if (!replacement.ok) return replacement;
      return client.call('b3.supervision.updateWatch', {
        watchRuleId: current.value.id,
        expectedRecordVersion: expected.value,
        replacement: replacement.value,
      }, clientOpId.value);
    }), (rule) => `Updated ${rule.id} to record version ${String(rule.recordVersion)}.`);
  },

  [REMOVE_COMMAND]: async function removeWatcher(argFlags) {
    const expected = expectedVersion(argFlags);
    if (!expected.ok) return fail('watch.remove', argFlags, expected.error);
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch.remove', argFlags, clientOpId, () => '');
    emit('watch.remove', argFlags, await withClient<WatchRule>(async (client) => {
      const current = await currentRule(client, argFlags.positional[0]);
      if (!current.ok) return current;
      // Retirement is a full replacement built from the live rule (the body),
      // fenced by the version the OPERATOR quoted (the precondition).
      return client.call('b3.supervision.updateWatch', {
        ...watchRemoveRetirement(current.value),
        expectedRecordVersion: expected.value,
      } as unknown as Readonly<Record<string, unknown>>, clientOpId.value);
    }), (rule) => `Retired ${rule.id}.`);
  },

  /**
   * A5-02, and the site with the most to answer for: it read the deadline for
   * its version, took the episode from an unratified `--episode`, and wrote the
   * operator's REASON for them. All three are the operator's to state — a
   * durable record of why a human overrode a drift alarm, signed by the tool,
   * is not a record of anything.
   *
   * The deadline is no longer read at all: `--expect-version` supplies the
   * fence and the positional id is the deadline, so there is nothing left to
   * look up.
   */
  [RESET_DRIFT_COMMAND]: async function resetDrift(argFlags) {
    const watchDeadlineId = argFlags.positional[0];
    const expected = expectedVersion(argFlags);
    if (!expected.ok) return fail('watch.reset-drift', argFlags, expected.error);
    const episode = expectedEpisode(argFlags);
    if (!episode.ok) return fail('watch.reset-drift', argFlags, episode.error);
    const reason = requiredReason(argFlags);
    if (!reason.ok) return fail('watch.reset-drift', argFlags, reason.error);
    const clientOpId = clientOpIdFrom(argFlags);
    if (!clientOpId.ok) emit('watch.reset-drift', argFlags, clientOpId, () => '');
    if (!isValidId(watchDeadlineId, 'watchDeadline', 'base32sha256')) {
      return fail('watch.reset-drift', argFlags, validationFailed([{
        path: 'watchDeadlineId', message: 'must be a WatchDeadlineId positional argument',
      }]));
    }
    emit('watch.reset-drift', argFlags, await withClient<WatchDeadline>(
      (client) => client.call('b3.supervision.resetDrift', {
        watchDeadlineId,
        expectedRecordVersion: expected.value,
        expectedEpisodeId: episode.value,
        reason: reason.value,
      }, clientOpId.value),
    ), (deadline) => `Reset drift deadline ${deadline.id}.`);
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
