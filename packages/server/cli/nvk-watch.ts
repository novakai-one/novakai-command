#!/usr/bin/env -S npx tsx
// nvk-watch — see what is watching, and what it has queued (§17.1).
//
//   nvk watch list           the standing watcher rules and their deadlines
//   nvk watch notifications  the durable Notification queue
//
// Both take --json (§17.2). TRACER SCOPE: §17.1 names seven verbs, and these
// are the two reads the B3d wire needs to be VISIBLE. `add`, `update`,
// `remove`, `acknowledge` and `reset-drift` are mutations belonging to lanes B
// and C, and a stub that pretended to perform one would be worse than its
// absence — an operator would believe a watcher was retired when it was not.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b3err, b3fail, type B3Result } from '@novakai/foundation/contract';
import type {
  Notification, WatchDeadline, WatchRule,
} from '../../supervision/contract/index.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { emit, parseFlags, type Flags } from '../core/b3/cli-shared.js';

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

const COMMANDS: Record<string, (argFlags: Flags) => Promise<never>> = {
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
    message: `usage: nvk watch ${Object.keys(COMMANDS).join('|')} [--json] [--limit <n>]`,
  })}\n`);
  process.exitCode = 2;
} else {
  await chosen(flags);
}
