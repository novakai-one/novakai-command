// B3e lane A — the DERIVATION half of A7-03 item 5: the three rules that turn
// one published Terminal read into §19.1's controllers section, plus the live
// proof that the section survives the wire.
//
// The rules are NVK-KIMI-089's, not this lane's:
//   1. only `state === 'attached'` counts as connected — `detached` and
//      `stale` are not (§7:1172, §20:3829). A stale attachment is precisely a
//      controller that may have stopped watching, so counting it would answer
//      "who is watching now" with "who was watching once".
//   2. `kinds` is the deduplicated set, in §7:1155 DECLARATION order — so two
//      reads of one unchanged session are byte-identical. Arrival order would
//      make the same state render differently between calls (FZ-VIEW-034).
//   3. `inputLeaseHolder` is the holder of the session's ACTIVE lease
//      (§7:1183), omitted when there is none. Omission is "no holder", never
//      "unknown".
//
// These are exercised against Terminal's real published `TerminalSessionView`
// type, so a change to that record's shape is a compile error here rather than
// a silent miscount.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/governed/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { controllersOf } from '../../core/runtime-host/run-ports.js';
import { chatRole } from '../governed-role.js';
import type { ControllerAttachment, TerminalSessionView } from '../../../terminal/contract/index.js';
import { spawnAgentFixture } from '../support/spawn-agent-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

// ── Rules 1–3, over Terminal's own published view ───────────────────────────

let nextAttachment = 0;

function attachment(
  state: ControllerAttachment['state'],
  controllerKind: ControllerAttachment['controllerKind'],
): ControllerAttachment {
  nextAttachment += 1;
  return {
    id: `controller_019fd400-0000-7000-8000-00000000000${nextAttachment}`,
    kind: 'controllerAttachment',
    schemaVersion: 1,
    recordVersion: 1,
    createdAt: '2026-08-06T01:00:00.000Z',
    createdBy: 'person_chris',
    permissionLevel: 'private',
    terminalSessionId: 'terminal_019fd400-0000-7000-8000-000000000000',
    controllerKind,
    principalId: 'person_chris',
    connectedAt: '2026-08-06T01:00:00.000Z',
    lastSeenAt: '2026-08-06T01:00:00.000Z',
    focused: false,
    state,
    draftState: 'empty',
    draftGeneration: 0,
  } as unknown as ControllerAttachment;
}

function sessionWith(
  attachments: readonly ControllerAttachment[],
  activeInputLease?: TerminalSessionView['activeInputLease'],
): TerminalSessionView {
  return {
    session: {} as TerminalSessionView['session'],
    attachments,
    ...(activeInputLease === undefined ? {} : { activeInputLease }),
    replay: { earliestSequence: 0, latestSequence: 0 },
    nextInputSequence: 1,
  };
}

const lease = (
  attachmentId: string, state: 'active' | 'released' | 'revoked',
): TerminalSessionView['activeInputLease'] =>
  ({ attachmentId, state } as unknown as TerminalSessionView['activeInputLease']);

test('rule 1: detached and stale attachments are not connected', () => {
  const facts = controllersOf(sessionWith([
    attachment('attached', 'novakai-shell'),
    attachment('detached', 'novakai-shell'),
    attachment('stale', 'external-terminal'),
  ]));
  assert.equal(facts.attachedCount, 1);
  // The stale one's KIND must not leak into the answer either: it is not
  // watching, so naming it would say a controller of that kind is connected.
  assert.deepEqual(facts.kinds, ['novakai-shell']);
});

test('rule 1: a session nobody is attached to counts zero, and says so', () => {
  const facts = controllersOf(sessionWith([attachment('detached', 'script')]));
  assert.equal(facts.attachedCount, 0);
  assert.deepEqual(facts.kinds, []);
});

test('rule 2: kinds are deduplicated', () => {
  const facts = controllersOf(sessionWith([
    attachment('attached', 'novakai-shell'),
    attachment('attached', 'novakai-shell'),
    attachment('attached', 'script'),
  ]));
  assert.equal(facts.attachedCount, 3, 'three controllers ARE attached');
  assert.deepEqual(facts.kinds, ['novakai-shell', 'script'], 'but only two kinds of them');
});

test('rule 2: kinds come back in declaration order, whatever order they arrived in', () => {
  const arrived = controllersOf(sessionWith([
    attachment('attached', 'operations'),
    attachment('attached', 'novakai-shell'),
    attachment('attached', 'script'),
    attachment('attached', 'external-terminal'),
  ]));
  assert.deepEqual(arrived.kinds, [
    'novakai-shell', 'external-terminal', 'script', 'operations',
  ]);

  // The same state, listed the other way round, must read identically —
  // otherwise two hosts drawing one session disagree (FZ-VIEW-034).
  const reversed = controllersOf(sessionWith([
    attachment('attached', 'external-terminal'),
    attachment('attached', 'script'),
    attachment('attached', 'novakai-shell'),
    attachment('attached', 'operations'),
  ]));
  assert.deepEqual(reversed.kinds, arrived.kinds);
});

test('rule 3: the active lease holder is named', () => {
  const holder = 'controller_019fd400-0000-7000-8000-0000000000aa';
  const facts = controllersOf(sessionWith(
    [attachment('attached', 'novakai-shell')], lease(holder, 'active'),
  ));
  assert.equal(facts.inputLeaseHolder, holder);
});

test('rule 3: a lease that is no longer active has no holder — omitted, not guessed', () => {
  for (const state of ['released', 'revoked'] as const) {
    const facts = controllersOf(sessionWith(
      [attachment('attached', 'novakai-shell')],
      lease('controller_019fd400-0000-7000-8000-0000000000bb', state),
    ));
    assert.equal(facts.inputLeaseHolder, undefined, `a ${state} lease named a holder`);
  }
  const none = controllersOf(sessionWith([attachment('attached', 'novakai-shell')]));
  assert.equal(none.inputLeaseHolder, undefined);
});

// ── The same section, over a live Runtime and the real wire ─────────────────

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

interface Envelope {
  readonly command?: string;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code?: string };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

async function withSpawnedAgent(
  work: (where: readonly string[], runId: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-controllers-'));
  let host: RunningRuntimeHost | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const where = ['--root', root, '--port', String(host.port), '--json'];
    const roleFile = path.join(root, 'role.json');
    writeFileSync(roleFile, JSON.stringify(chatRole('controller-builder')), 'utf8');
    const defined = await runNvk(['agent', 'define-role', '--file', roleFile, ...where]);
    assert.equal(defined.code, 0, `define-role failed: ${defined.out}`);
    const spawned = await spawnAgentFixture({
      root, port: host.port, roleName: 'controller-builder', displayName: 'Watched',
      workingDirectory: root,
    });
    const runId = String(spawned.run.id);
    await work(where, runId);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a real Run view carries the controllers section across the wire', async () => {
  await withSpawnedAgent(async (where, runId) => {
    const run = await runNvk(['agent', 'inspect', runId, ...where]);
    assert.equal(run.code, 0, `inspect exited ${String(run.code)}: ${run.out}`);
    const value = envelopeOf(run).value ?? {};
    const controllers = value['controllers'] as
      { attachedCount?: unknown; kinds?: unknown } | undefined;
    assert.notEqual(controllers, undefined, 'the view arrived with no controllers section');
    assert.equal(typeof controllers?.attachedCount, 'number');
    assert.ok(Array.isArray(controllers?.kinds));
    // Nobody has attached to this Run's PTY, and the Runtime says so rather
    // than leaving the caller to infer it from an absent field.
    assert.equal(controllers?.attachedCount, 0);
  });
});

test('the human line states the controller truth §17.2:3605 requires', async () => {
  await withSpawnedAgent(async (where, runId) => {
    const human = where.filter((flagOrValue) => flagOrValue !== '--json');
    const run = await runNvk(['agent', 'inspect', runId, ...human]);
    assert.equal(run.code, 0, `inspect exited ${String(run.code)}: ${run.out}`);
    assert.match(run.out, /Started from/u);
    assert.match(run.out, /currently 0 controllers/u);
  });
});

test('`agent list` with no --limit succeeds — which proves the CLI supplied one', async () => {
  await withSpawnedAgent(async (where) => {
    // A7-03 item 6 (A5-01), and it is only observable now that the owner
    // REQUIRES `limit`: if the CLI sent none, the boundary would refuse this
    // with ValidationFailed instead of answering.
    const listed = await runNvk(['agent', 'list', ...where]);
    assert.equal(listed.code, 0, `list exited ${String(listed.code)}: ${listed.out}`);
    const envelope = envelopeOf(listed);
    assert.equal(envelope.error, undefined);
    assert.equal(envelope.command, 'agent.list');
  });
});

test('a --limit above the ratified cap is refused, not silently clamped', async () => {
  await withSpawnedAgent(async (where) => {
    const listed = await runNvk(['agent', 'list', '--limit', '500', ...where]);
    assert.notEqual(listed.code, 0, 'a 500-item page was accepted');
    assert.match(listed.out, /limit/u);
  });
});
