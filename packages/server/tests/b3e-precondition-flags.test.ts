// AMD-005 A5-02 — "the CLI never reads a record in order to supply [a
// concurrency precondition]".
//
// The CLI did exactly that in FIVE places, each with a comment explaining why
// it was safe. It is not safe, and the comment on `agent control` says why
// without meaning to: "the version the CALLER read". It is the version the CLI
// read a millisecond earlier, on the caller's behalf, without asking.
//
// A compare-and-set whose expected value the writer just fetched is a
// last-writer-wins with extra steps. The operator's "I looked at version 3 and
// decided to interrupt THAT" is never expressed anywhere, and the exact race
// CAS exists to catch — somebody else changed the record between the operator
// deciding and the command running — is the one race this shape cannot catch,
// because the CLI's read happens after the operator has already decided.
//
// So the precondition becomes an explicit flag at every site, and a required
// precondition whose flag is omitted is `ValidationFailed`.
//
// Everything here is hermetic: a data root with NO runtime token, so the CLI's
// own refusals are visible as themselves, and an accepted form is visible as
// the `RuntimeUnavailable` it can only reach by dispatching. That distinction
// is the whole test — it is how a refusal that never opened a socket is told
// apart from one the owner made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from '../core/runtime-host/cli-shared.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

const NO_RUNTIME_ROOT = path.join(repoRoot, 'packages', 'server', 'tests', '.no-such-root');
const NO_RUNTIME_PORT = '59422';

const AGENT = 'agent_123e4567-e89b-42d3-a456-426614174000';
const RUN = 'agentRun_019fd000-0000-7000-8000-0000000000a1';
const RUN_TWO = 'agentRun_019fd000-0000-7000-8000-0000000000a2';
const EPOCH = 'runtimeEpoch_019fd000-0000-7000-8000-0000000000c3';
const RULE = 'watchRule_019fd000-0000-7000-8000-0000000000d4';
const DEADLINE = `watchDeadline_${'a'.repeat(52)}`;
const EPISODE = `driftEpisode_${'b'.repeat(52)}`;

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args,
    '--json', '--root', NO_RUNTIME_ROOT, '--port', NO_RUNTIME_PORT], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

interface Envelope {
  readonly command?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

/**
 * A refusal the CLI made itself: `ValidationFailed`, exit 2, naming the flag
 * the operator left out. Reaching a socket would answer `RuntimeUnavailable`
 * instead, so this assertion is also the proof that nothing was dispatched.
 */
function assertRefusedHere(
  run: CliRun, command: string, flag: RegExp,
): void {
  const envelope = envelopeOf(run);
  assert.equal(envelope.error?.code, 'ValidationFailed',
    `the precondition was supplied by the CLI instead of refused: ${run.out}`);
  assert.equal(run.code, 2, `exit drifted from the ruled table: ${run.out}`);
  assert.equal(envelope.command, command, run.out);
  assert.match(envelope.error?.message ?? '', flag,
    `the refusal did not name the missing flag: ${run.out}`);
}

/**
 * The command got past the CLI with nothing left to object to, and died where
 * a hermetic root always dies. If the CLI still read a record first, THIS is
 * the assertion that would keep passing while the CAS stayed a lie — so it is
 * never used alone; each site also has a "no read happened" test above it.
 */
function assertDispatched(run: CliRun, command: string): void {
  const envelope = envelopeOf(run);
  assert.equal(envelope.error?.code, 'RuntimeUnavailable',
    `the ratified form was refused by the CLI: ${run.out}`);
  assert.equal(envelope.command, command, run.out);
}

// ---------------------------------------------------------------------------
// 1. the flag parser — `--confirmed-run` is repeatable and `parseFlags` is a Map
// ---------------------------------------------------------------------------

test('parseFlags keeps every occurrence of a repeatable flag, in order', () => {
  const flags = parseFlags(['--confirmed-run', RUN, '--confirmed-run', RUN_TWO]);
  assert.deepEqual(flags.values('confirmed-run'), [RUN, RUN_TWO],
    'a Map keyed by flag name silently drops all but one confirmed Run — and a '
    + 'stop that confirms one Run while the operator named two is a stop that '
    + 'refuses to stop what it was told it could');
});

test('values() of a flag nobody passed is empty, not undefined', () => {
  assert.deepEqual(parseFlags([]).values('confirmed-run'), []);
});

test('values() of a flag passed once is that one value', () => {
  assert.deepEqual(parseFlags(['--confirmed-run', RUN]).values('confirmed-run'), [RUN]);
});

// ---------------------------------------------------------------------------
// 2. agent interrupt — `--expect-version`
// ---------------------------------------------------------------------------

test('agent interrupt with no --expect-version is refused, not filled in by a getRun', async () => {
  assertRefusedHere(
    await runNvk(['agent', 'interrupt', RUN]), 'agent.interrupt', /--expect-version/,
  );
});

test('agent interrupt with --expect-version reaches the Runtime', async () => {
  assertDispatched(
    await runNvk(['agent', 'interrupt', RUN, '--expect-version', '3']), 'agent.interrupt',
  );
});

test('a version that is not a whole number is an encoding error the CLI can see', async () => {
  assertRefusedHere(
    await runNvk(['agent', 'interrupt', RUN, '--expect-version', 'abc']),
    'agent.interrupt', /whole number/,
  );
});

// ---------------------------------------------------------------------------
// 3. agent control — `--expect-version`, and FZ-CLI-022's `--name/--value`
// ---------------------------------------------------------------------------

test('agent control with no --expect-version is refused', async () => {
  assertRefusedHere(
    await runNvk(['agent', 'control', RUN, '--name', 'model', '--value', 'opus']),
    'agent.control', /--expect-version/,
  );
});

test('agent control spells FZ-CLI-022s --name/--value, not --set name=value', async () => {
  assertDispatched(
    await runNvk(['agent', 'control', RUN,
      '--expect-version', '2', '--name', 'model', '--value', 'opus']),
    'agent.control',
  );
});

test('the retired --set spelling is refused rather than quietly still working', async () => {
  assertRefusedHere(
    await runNvk(['agent', 'control', RUN, '--expect-version', '2', '--set', 'model=opus']),
    'agent.control', /--name/,
  );
});

test('agent control judges no control NAME of its own — the owner owns that choice', async () => {
  // §3.2: a second opinion here is a second policy path. `AGENT_CONTROL_NAMES`
  // is the owner's closed set (`readApplyRunControlInput`), so an unknown name
  // must travel and be refused THERE, not be second-guessed at the keyboard.
  assertDispatched(
    await runNvk(['agent', 'control', RUN,
      '--expect-version', '2', '--name', 'not-a-control', '--value', 'x']),
    'agent.control',
  );
});

// ---------------------------------------------------------------------------
// 4. agent adopt — the unratified `--expect` takes A5-02's ruled name
// ---------------------------------------------------------------------------

test('agent adopt takes A5-02s --expect-version', async () => {
  assertDispatched(
    await runNvk(['agent', 'adopt', AGENT, '--supervisor', AGENT, '--expect-version', '1']),
    'agent.adopt',
  );
});

test('the unratified --expect spelling is gone, not aliased', async () => {
  // E1 forbids renaming a RATIFIED flag. `--expect` was never ratified, so
  // adopting the ruled name is the fix; keeping both would leave two spellings
  // of one precondition, which is how they drift apart again.
  assertRefusedHere(
    await runNvk(['agent', 'adopt', AGENT, '--supervisor', AGENT, '--expect', '1']),
    'agent.adopt', /--expect-version/,
  );
});

// ---------------------------------------------------------------------------
// 5. runtime stop — `--expect-epoch`, `--confirmed-run` (repeatable)
// ---------------------------------------------------------------------------

test('runtime stop with no --expect-epoch is refused, not filled in by a getStatus', async () => {
  assertRefusedHere(
    await runNvk(['runtime', 'stop', '--live-runs', 'refuse']),
    'runtime.stop', /--expect-epoch/,
  );
});

test('runtime stop with the epoch the operator saw reaches the Runtime', async () => {
  assertDispatched(
    await runNvk(['runtime', 'stop', '--live-runs', 'refuse', '--expect-epoch', EPOCH]),
    'runtime.stop',
  );
});

test('an epoch that is not a RuntimeEpochId is refused before a socket opens', async () => {
  assertRefusedHere(
    await runNvk(['runtime', 'stop', '--live-runs', 'refuse', '--expect-epoch', 'epoch-3']),
    'runtime.stop', /--expect-epoch/,
  );
});

test('runtime stop accepts --confirmed-run more than once', async () => {
  assertDispatched(
    await runNvk(['runtime', 'stop', '--live-runs', 'stop-explicitly',
      '--expect-epoch', EPOCH, '--confirmed-run', RUN, '--confirmed-run', RUN_TWO]),
    'runtime.stop',
  );
});

test('a malformed confirmed Run is refused — it names a Run nobody can have seen', async () => {
  assertRefusedHere(
    await runNvk(['runtime', 'stop', '--live-runs', 'stop-explicitly',
      '--expect-epoch', EPOCH, '--confirmed-run', 'run-7']),
    'runtime.stop', /--confirmed-run/,
  );
});

// ---------------------------------------------------------------------------
// 6. watch update / remove — `--expect-version`
// ---------------------------------------------------------------------------

test('watch update with no --expect-version is refused before the rule is read', async () => {
  assertRefusedHere(
    await runNvk(['watch', 'update', RULE, '--when', 'run-final']),
    'watch.update', /--expect-version/,
  );
});

test('watch remove with no --expect-version is refused before the rule is read', async () => {
  assertRefusedHere(
    await runNvk(['watch', 'remove', RULE]), 'watch.remove', /--expect-version/,
  );
});

test('watch remove with the version the operator saw reaches the Runtime', async () => {
  assertDispatched(
    await runNvk(['watch', 'remove', RULE, '--expect-version', '4']), 'watch.remove',
  );
});

// ---------------------------------------------------------------------------
// 7. watch reset-drift — `--expect-version`, `--expect-episode`, `--reason`
// ---------------------------------------------------------------------------

test('watch reset-drift with no --expect-version is refused', async () => {
  assertRefusedHere(
    await runNvk(['watch', 'reset-drift', DEADLINE,
      '--expect-episode', EPISODE, '--reason', 'the agent was waiting on me']),
    'watch.reset-drift', /--expect-version/,
  );
});

test('watch reset-drift with no --expect-episode is refused', async () => {
  // The episode is the fence that makes a reset apply to the drift the operator
  // actually looked at. `--episode` was the shipped spelling and was never
  // ratified; A5-02 names `--expect-episode`.
  assertRefusedHere(
    await runNvk(['watch', 'reset-drift', DEADLINE,
      '--expect-version', '2', '--reason', 'the agent was waiting on me']),
    'watch.reset-drift', /--expect-episode/,
  );
});

test('watch reset-drift with no --reason is refused rather than given one by the CLI', async () => {
  // The shipped default was `'reset requested by nvk watch reset-drift'` — a
  // durable record of WHY a human overrode a drift alarm, written by the tool
  // instead of the human. `reason` is required at the owner's boundary
  // (`field.text('reason')`), so A5-02's flag is required here.
  assertRefusedHere(
    await runNvk(['watch', 'reset-drift', DEADLINE,
      '--expect-version', '2', '--expect-episode', EPISODE]),
    'watch.reset-drift', /--reason/,
  );
});

test('the ratified reset-drift trio reaches the Runtime', async () => {
  assertDispatched(
    await runNvk(['watch', 'reset-drift', DEADLINE, '--expect-version', '2',
      '--expect-episode', EPISODE, '--reason', 'the agent was waiting on me']),
    'watch.reset-drift',
  );
});
