// A5-03: `nvk agent spawn … [--task supervised --brief <text>]`.
//
// The shipped CLI spelled it `--task "<the brief>"` — the brief WAS the flag's
// value — so the one word the amendment makes a closed choice was a free text
// field, and a `SpawnAgentInput.task` was minted from whatever an operator
// typed. Two things follow from that, and both are why the amendment is worth
// implementing rather than aliasing:
//
//   * `--task "write the report"` produced `{kind:'supervised', brief:'write
//     the report'}`, so EVERY use of the flag was supervised work, whether or
//     not the operator meant to open the two-turn gate;
//   * `--brief` did nothing at all, which means the ratified form — the one an
//     operator reading §17.1 would type — silently spawned UNsupervised work
//     with the brief dropped on the floor. That is the shape of defect the
//     `--cursor` find named one slice ago: a flag the surface publishes, the
//     CLI accepts, and nobody sends.
//
// The three refusals are encoding errors the CLI can see without a Runtime, so
// they are proven on the hermetic no-token root (exit 2, before any socket).
// The accepted form is driven against a live Runtime, because "it spawns" is
// the only thing that proves the payload the owner's boundary reader accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/b3/host.js';
import { chatRole } from '../governed-role.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

/** No runtime token under this root: a dispatched call cannot reach a socket. */
const NO_RUNTIME_ROOT = path.join(repoRoot, 'packages', 'server', 'tests', '.no-such-root');
const NO_RUNTIME_PORT = '59418';

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[], where: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args, ...where], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

const HERMETIC = ['--json', '--root', NO_RUNTIME_ROOT, '--port', NO_RUNTIME_PORT] as const;

interface Envelope {
  readonly command?: string;
  readonly ok?: boolean;
  readonly error?: { readonly code?: string; readonly details?: {
    readonly issues?: ReadonlyArray<{ readonly path?: string }>;
  } };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

const pathsIn = (envelope: Envelope): readonly string[] =>
  (envelope.error?.details?.issues ?? []).map((issue) => issue.path ?? '');

test('--task without --brief is refused, and says which field is missing', async () => {
  const run = await runNvk(
    ['agent', 'spawn', '--role', 'builder', '--name', 'Nova', '--task', 'supervised'],
    HERMETIC,
  );
  assert.equal(run.code, 2, `expected the usage exit, got ${String(run.code)}: ${run.out}`);
  const envelope = envelopeOf(run);
  assert.equal(envelope.command, 'agent.spawn');
  assert.equal(envelope.error?.code, 'ValidationFailed');
  assert.deepEqual(pathsIn(envelope), ['brief']);
});

test('--brief without --task is refused: an unsupervised brief goes nowhere', async () => {
  const run = await runNvk(
    ['agent', 'spawn', '--role', 'builder', '--name', 'Nova', '--brief', 'write the report'],
    HERMETIC,
  );
  assert.equal(run.code, 2, `expected the usage exit, got ${String(run.code)}: ${run.out}`);
  const envelope = envelopeOf(run);
  assert.equal(envelope.error?.code, 'ValidationFailed');
  assert.deepEqual(pathsIn(envelope), ['task']);
});

test('--task takes ONE word, and the old free-text form is refused by name', async () => {
  // This is the shipped spelling. It used to spawn supervised work with this
  // sentence as the brief; the amendment makes `task` a closed choice, so an
  // operator who types the old form is told rather than quietly obeyed.
  const run = await runNvk(
    ['agent', 'spawn', '--role', 'builder', '--name', 'Nova', '--task', 'write the report'],
    HERMETIC,
  );
  assert.equal(run.code, 2, `expected the usage exit, got ${String(run.code)}: ${run.out}`);
  const envelope = envelopeOf(run);
  assert.equal(envelope.error?.code, 'ValidationFailed');
  assert.deepEqual(pathsIn(envelope), ['task']);
});

test('no --task and no --brief still spawns — the flag pair is optional', async () => {
  const run = await runNvk(
    ['agent', 'spawn', '--role', 'builder', '--name', 'Nova'],
    HERMETIC,
  );
  // It reaches the Runtime and fails there for the hermetic reason, which is
  // exactly the proof that the CLI raised no encoding objection of its own.
  assert.equal(envelopeOf(run).error?.code, 'RuntimeUnavailable',
    `an unsupervised spawn was refused before dispatch: ${run.out}`);
});

/**
 * A live Runtime with one INTERACTIVE-CHAT role defined — the role whose gate is
 * `disabled`, which §6.3 permits for a chat launch and refuses for supervised
 * work. That refusal is the observable this pair is built on: the owner itself
 * tells us whether a `task` arrived, without the CLI being asked to report on
 * its own payload.
 */
async function withChatRole(work: (where: readonly string[]) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-spawn-task-'));
  let host: RunningRuntimeHost | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const where = ['--root', root, '--port', String(host.port), '--json'];
    const roleFile = path.join(root, 'role.json');
    writeFileSync(roleFile, JSON.stringify(chatRole('task-builder')), 'utf8');
    const defined = await runNvk(['agent', 'define-role', '--file', roleFile], where);
    assert.equal(defined.code, 0, `define-role failed: ${defined.out}`);
    await work(where);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const SPAWN = ['agent', 'spawn', '--role', 'task-builder', '--name', 'Tasker'] as const;

test('the ratified form reaches the owner AS supervised work', async () => {
  await withChatRole(async (where) => {
    const spawned = await runNvk([...SPAWN, '--cwd', '.',
      '--task', 'supervised', '--brief', 'read the freeze and report'], where);
    // The chat role's gate is `disabled`, so the Runtime refuses supervised work
    // on it by name. That refusal IS the proof the task travelled: an omitted
    // one would have spawned happily (the next test).
    assert.equal(envelopeOf(spawned).error?.code, 'LaunchPlanInvalid',
      `expected the owner's supervised-work refusal, got: ${spawned.out}`);
    // A5-11: `LaunchPlanInvalid` is a validation exit. Read off the ruled
    // table rather than guessed at — the CLI's own refusals above share it,
    // which is right: both say "this request cannot be made as written".
    assert.equal(spawned.code, 2, `exit code drifted from the ruled table: ${spawned.out}`);
    // The role could not run supervised work for two reasons, and the operator
    // is told BOTH — a first-issue-only refusal makes fixing it a guessing game.
    const issues = (envelopeOf(spawned).error?.details?.issues ?? []).map((issue) => issue.path);
    assert.deepEqual(issues, ['skillsConfirmationGate.mode', 'skills']);
  });
});

test('with no --task the input carries no task at all — the same role spawns', async () => {
  await withChatRole(async (where) => {
    const spawned = await runNvk([...SPAWN, '--cwd', '.'], where);
    assert.equal(spawned.code, 0, `an unsupervised spawn was refused: ${spawned.out}`);
    const envelope = envelopeOf(spawned);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, 'agent.spawn');
  });
});
