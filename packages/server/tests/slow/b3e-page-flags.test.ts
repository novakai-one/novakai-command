// B3e lane A — A5-01: every command whose `--json` value is a `Page<T>` accepts
// `--limit <n>` (1–200) and `--cursor <EventCursor>`, both handed to the list
// method unchanged, with 200 supplied when `--limit` is omitted. The CLI never
// re-pages, merges pages, filters items, or recomputes `omissions`.
//
// Only `agent list` had the flags. `watch list`, `watch notifications` and
// `agent communications` each spelled their own `Number(--limit ?? 50)`:
//   - a different default from the published one, three times over;
//   - no validation at all, so `--limit abc` sent `NaN` and `--limit 5000` sent
//     a page size the ruling bounds at 200;
//   - no `--cursor`, so the second page of anything was unreachable by CLI
//     even though every one of those list methods takes an opaque cursor.
//
// The refusals are proven on a data root with NO runtime token: a command that
// refuses a bad `--limit` there has refused it BEFORE opening a socket, which
// is the property that matters — the CLI validates the encoding it is about to
// send, rather than discovering it from the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { chatRole } from '../governed-role.js';
import { spawnAgentFixture } from '../support/spawn-agent-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

const NO_RUNTIME_ROOT = path.join(repoRoot, 'packages', 'server', 'tests', '.no-such-root');
const NO_RUNTIME_PORT = '59420';
const AGENT = 'agent_123e4567-e89b-42d3-a456-426614174000';

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

const nowhere = (args: readonly string[]): Promise<CliRun> =>
  runNvk([...args, '--json', '--root', NO_RUNTIME_ROOT, '--port', NO_RUNTIME_PORT]);

interface Envelope {
  readonly command?: string;
  readonly value?: Record<string, unknown>;
  readonly error?: {
    readonly code?: string;
    readonly details?: { readonly issues?: readonly { readonly path?: string }[] };
  };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

/** Every §17.1 command whose `--json` value is a `Page<T>`, with an argv that
 * reaches the operation. `terminal list` is A5-05 and is not one of these yet. */
const PAGE_COMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['agent.list', ['agent', 'list']],
  ['agent.communications', ['agent', 'communications', AGENT]],
  ['watch.list', ['watch', 'list']],
  ['watch.notifications', ['watch', 'notifications']],
];

for (const [command, argv] of PAGE_COMMANDS) {
  test(`${command} refuses a --limit outside 1–200, before the runtime`, async () => {
    for (const bad of ['0', '201', 'abc', '1.5']) {
      const run = await nowhere([...argv, '--limit', bad]);
      const envelope = envelopeOf(run);
      assert.equal(run.code, 2, `${command} --limit ${bad} exited ${String(run.code)}: ${run.out}`);
      assert.equal(envelope.command, command);
      assert.equal(envelope.error?.code, 'ValidationFailed');
      assert.deepEqual(envelope.error?.details?.issues?.map((issue) => issue.path), ['limit'],
        `${command} --limit ${bad} blamed the wrong field: ${run.out}`);
    }
  });

  test(`${command} accepts --limit and --cursor and gets as far as the runtime`, async () => {
    // The positive half of the same law: a legal page request is NOT refused
    // locally — it travels, and the only thing that stops it here is the
    // absent runtime.
    const run = await nowhere([...argv, '--limit', '5', '--cursor', 'evt_whatever']);
    assert.equal(envelopeOf(run).error?.code, 'RuntimeUnavailable',
      `${command} refused a legal page request: ${run.out}`);
  });
}

/** A live Runtime with `count` governed Agents prepared through its internal test door. */
async function withAgents(
  count: number, work: (where: readonly string[], agentIds: readonly string[]) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-page-'));
  let host: RunningRuntimeHost | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const where = ['--root', root, '--port', String(host.port), '--json'];
    const roleFile = path.join(root, 'role.json');
    writeFileSync(roleFile, JSON.stringify(chatRole('page-builder')), 'utf8');
    await runNvk(['agent', 'define-role', '--file', roleFile, ...where]);
    const agentIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      // Sequential on purpose: a keyset page over `(createdAt,id)` is only
      // meaningfully ordered if the records were not all minted at once.
      const spawned = await spawnAgentFixture({
        root, port: host.port, roleName: 'page-builder', displayName: `Pager ${index}`,
        workingDirectory: root,
      });
      agentIds.push(String(spawned.agent.agentId));
    }
    await work(where, agentIds);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const itemsOf = (envelope: Envelope): readonly Record<string, unknown>[] =>
  (envelope.value?.['items'] ?? []) as readonly Record<string, unknown>[];

test('--limit and --cursor page a real listing, and the CLI never re-pages', async () => {
  await withAgents(2, async (where) => {
    const first = envelopeOf(await runNvk(['agent', 'list', '--limit', '1', ...where]));
    assert.equal(itemsOf(first).length, 1, `--limit 1 returned ${itemsOf(first).length} items`);
    const cursor = first.value?.['nextCursor'];
    assert.equal(typeof cursor, 'string', `no nextCursor to page with: ${JSON.stringify(first)}`);

    const second = envelopeOf(await runNvk([
      'agent', 'list', '--limit', '1', '--cursor', String(cursor), ...where]));
    assert.equal(itemsOf(second).length, 1);
    // The page the OWNER minted, resumed: a CLI that re-paged, merged or
    // filtered would show the same Run twice or lose one between pages.
    const idOf = (page: Envelope): unknown =>
      (itemsOf(page)[0]?.['run'] as Record<string, unknown> | undefined)?.['id'];
    assert.notEqual(idOf(second), idOf(first), 'the second page repeated the first');

    // And the whole listing, unpaged, holds both — so nothing was invented.
    const all = envelopeOf(await runNvk(['agent', 'list', ...where]));
    assert.equal(itemsOf(all).length, 2, `unpaged listing: ${JSON.stringify(all)}`);
  });
});

test('a cursor from another query is refused, never quietly restarted', async () => {
  // The defect underneath the missing `nextCursor`: `ListAgentRunsFilter` had
  // no `cursor` field at all (pass2 §12.7 declares one), so the boundary read
  // the payload and dropped it. A caller resuming from a cursor was handed
  // page one again while believing it had continued — a silent wrong answer,
  // which is worse than any refusal.
  await withAgents(1, async (where) => {
    const run = await runNvk(['agent', 'list', '--cursor', 'watchRules.bm90LWEtcnVu', ...where]);
    const envelope = envelopeOf(run);
    assert.equal(envelope.error?.code, 'ValidationFailed', `foreign cursor accepted: ${run.out}`);
    assert.deepEqual(envelope.error?.details?.issues?.map((issue) => issue.path), ['cursor']);
  });
});

test('watch list pages the rules the operator actually created', async () => {
  await withAgents(2, async (where, agentIds) => {
    const runs = envelopeOf(await runNvk(['agent', 'list', ...where]));
    const runIds = itemsOf(runs).map((item) =>
      String((item['run'] as Record<string, unknown>)['id']));
    assert.equal(runIds.length, 2);
    for (const runId of runIds) {
      const added = await runNvk(['watch', 'add', '--subject', runId, '--when', 'run-final',
        '--notify', agentIds[0]!, '--delivery', 'queue-only', ...where]);
      assert.equal(added.code, 0, `watch add failed: ${added.out}`);
    }
    const listed = envelopeOf(await runNvk(['watch', 'list', ...where]));
    const rules = (listed.value?.['rules'] ?? []) as readonly unknown[];
    assert.equal(rules.length, 2, `watch list: ${JSON.stringify(listed)}`);

    const paged = envelopeOf(await runNvk(['watch', 'list', '--limit', '1', ...where]));
    assert.equal(((paged.value?.['rules'] ?? []) as readonly unknown[]).length, 1,
      `--limit 1 did not reach listWatchRules: ${JSON.stringify(paged)}`);
  });
});
