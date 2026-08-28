// B3e lane A — A5-09 as superseded by NVK-KIMI-093: `nvk agent tree <agentId>
// [--depth <n>]`.
//
// The amendment originally ratified `--root <agentId>`, which collides with the
// GLOBAL `--root <path>` data-root flag every `nvk` command carries: one flag
// would have named two things, and an operator typing `--root agent_x` would
// have pointed the client at a directory called `agent_x` as well as
// mis-targeting the tree. The ruling makes the selector a bare positional —
// §17.1's own idiom for an Agent subject — and leaves `--root` alone.
//
// Three product facts follow, and each has a test here:
//   1. the selector is positional ONLY (the shipped `--agent` alias goes);
//   2. omitted ⇒ ValidationFailed exit 2, `issues:[{path:"rootAgentId"}]`,
//      naming the §12.7 input field rather than a flag that no longer exists;
//   3. `--depth` supplies `maxDepth`, default 10 — and `direction` is not sent
//      at all: pass2 §12.7's input is `{rootAgentId, maxDepth}`, so a
//      `--direction` flag is unratified input on a ratified command.
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

/** The hermetic root of `b3e-cli-command.test.ts`: no token, so every command
 * that reaches the runtime fails `RuntimeUnavailable` before opening a socket.
 * A refusal that must happen BEFORE dispatch is therefore observable here. */
const NO_RUNTIME_ROOT = path.join(repoRoot, 'packages', 'server', 'tests', '.no-such-root');
const NO_RUNTIME_PORT = '59419';
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

test('the tree selector omitted is ValidationFailed on rootAgentId, exit 2', async () => {
  const run = await nowhere(['agent', 'tree']);
  const envelope = envelopeOf(run);
  assert.equal(run.code, 2, `exited ${String(run.code)}: ${run.out}`);
  assert.equal(envelope.command, 'agent.tree');
  assert.equal(envelope.error?.code, 'ValidationFailed');
  assert.deepEqual(envelope.error?.details?.issues?.map((issue) => issue.path), ['rootAgentId']);
});

test('--agent is not a spelling of the selector either', async () => {
  // The shipped CLI accepted `--agent <id>` as an alias. It was the right
  // instinct against `--root`, but E1 (NVK-KIMI-092 §0) is explicit: an extra
  // may not add, rename or re-type a flag on a ratified command. The ruled
  // grammar is the positional, and nothing else.
  const run = await nowhere(['agent', 'tree', '--agent', AGENT]);
  assert.equal(run.code, 2, `--agent was accepted: ${run.out}`);
  assert.deepEqual(envelopeOf(run).error?.details?.issues?.map((issue) => issue.path),
    ['rootAgentId']);
});

test('--root still names the data root on agent tree, like everywhere else', async () => {
  // The whole reason for the ruling: with a positional selector present,
  // `--root` is unambiguously the data root — so this reaches the runtime and
  // fails for the ONE honest reason, rather than querying a tree rooted at a
  // directory path.
  const run = await nowhere(['agent', 'tree', AGENT]);
  assert.equal(envelopeOf(run).error?.code, 'RuntimeUnavailable', run.out);
});

/** A live Runtime with one governed Agent prepared through its internal test door. */
async function withSpawnedAgent(
  work: (where: readonly string[], agentId: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-tree-'));
  let host: RunningRuntimeHost | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const where = ['--root', root, '--port', String(host.port), '--json'];
    const roleFile = path.join(root, 'role.json');
    writeFileSync(roleFile, JSON.stringify(chatRole('tree-builder')), 'utf8');
    await runNvk(['agent', 'define-role', '--file', roleFile, ...where]);
    const spawned = await spawnAgentFixture({
      root, port: host.port, roleName: 'tree-builder', displayName: 'Rooted',
      workingDirectory: root,
    });
    const agentId = String(spawned.agent.agentId);
    await work(where, agentId);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('the positional selector queries the tree it names', async () => {
  await withSpawnedAgent(async (where, agentId) => {
    const run = await runNvk(['agent', 'tree', agentId, ...where]);
    assert.equal(run.code, 0, `tree failed: ${run.out}`);
    const envelope = envelopeOf(run);
    assert.equal(envelope.command, 'agent.tree');
    assert.equal(envelope.value?.['rootAgentId'], agentId);
    assert.ok(Array.isArray(envelope.value?.['nodes']), `no nodes: ${run.out}`);
  });
});

test('--depth reaches maxDepth, and out-of-range is refused by the owner', async () => {
  // `maxDepth` is bounded 0–64 at the frozen boundary. A depth the owner
  // refuses is the cheapest honest proof that the flag arrives as `maxDepth`
  // rather than being dropped on the floor — before this, `--depth` did not
  // exist and the CLI hard-coded 8, so nothing an operator typed could change
  // how deep the answer went.
  await withSpawnedAgent(async (where, agentId) => {
    const ok = await runNvk(['agent', 'tree', agentId, '--depth', '3', ...where]);
    assert.equal(ok.code, 0, `--depth 3 failed: ${ok.out}`);
    const refused = await runNvk(['agent', 'tree', agentId, '--depth', '65', ...where]);
    assert.equal(refused.code, 2, `--depth 65 was accepted: ${refused.out}`);
    assert.equal(envelopeOf(refused).error?.code, 'ValidationFailed');
  });
});

test('a --direction flag is not sent: the ratified input is {rootAgentId, maxDepth}', async () => {
  // pass2 §12.7's input has no `direction`, and OQ-08 dissolved the question.
  // The shipped CLI forwarded `--direction` straight through, so an unratified
  // flag on a ratified command could change the answer. It must now have no
  // effect whatsoever — same tree, flag or no flag.
  await withSpawnedAgent(async (where, agentId) => {
    // A value the frozen boundary would REFUSE if it ever arrived: `direction`
    // is an `optionalChoice` there, so "sideways" reaching the owner is a
    // ValidationFailed. Exit 0 is therefore proof the flag was never sent —
    // stronger than comparing two trees, which agree for a childless root
    // whichever way you walk.
    const directed = await runNvk(['agent', 'tree', agentId, '--direction', 'sideways', ...where]);
    assert.equal(directed.code, 0, `--direction reached the owner: ${directed.out}`);
    const plain = await runNvk(['agent', 'tree', agentId, ...where]);
    const nodesOf = (run: CliRun): number =>
      ((envelopeOf(run).value?.['nodes'] ?? []) as readonly unknown[]).length;
    assert.equal(nodesOf(directed), nodesOf(plain),
      `--direction changed the tree: ${directed.out}`);
  });
});
