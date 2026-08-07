// B3e lane A slice A1 — X-1: `CliOutput.command` is the resolved-form
// discriminator (NVK-KIMI-085 §0 X-1).
//
// `command: string` is published but unconstrained, so before this it carried
// whatever the call site felt like writing — the space form `"agent list"`, and
// one string for both halves of every dual-form command. OQ-09 and OQ-16 give
// `agent inspect` and `agent usage` two DIFFERENT value types depending on the
// argument, and `command` is the ruled discriminator for which one you got. A
// consumer that cannot tell `AgentRunView` from `Agent` without sniffing fields
// is exactly what the ruling closes.
//
// Two halves, deliberately:
//   1. the published vocabulary is X-1's closed set, verbatim;
//   2. every shipped command actually EMITS its member — driven end to end
//      through `scripts/nvk.mjs`, the way an operator and an exam row do.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULED_COMMANDS } from '../core/b3/cli-shared.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

/**
 * A data root with no runtime token. Every command then fails the same way —
 * `RuntimeUnavailable` — BEFORE it opens a socket, which is what makes this
 * suite hermetic: no runtime, no ports, no side effects, and still the real
 * `scripts/nvk.mjs` → adapter → `emit()` path an operator drives.
 */
const NO_RUNTIME_ROOT = path.join(repoRoot, 'packages', 'server', 'tests', '.no-such-root');
const NO_RUNTIME_PORT = '59417';

const AGENT = 'agent_123e4567-e89b-42d3-a456-426614174000';
const RUN = 'agentRun_019fd000-0000-7000-8000-0000000000a1';
const TERMINAL = 'terminalSession_019fd000-0000-7000-8000-0000000000b2';
// AMD-005 A5-02's preconditions are the operator's to state, so every affected
// row below carries the flag that used to be filled in by a read.
const EPOCH = 'runtimeEpoch_019fd000-0000-7000-8000-0000000000c3';
const EPISODE = `driftEpisode_${'b'.repeat(52)}`;

function runNvk(args: readonly string[]): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [nvk, ...args,
    '--json', '--root', NO_RUNTIME_ROOT, '--port', NO_RUNTIME_PORT], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

/**
 * One invocation per frozen command, with arguments good enough to REACH the
 * operation — so the `command` under test is the resolved one, not the one a
 * usage error happened to print. The two `.stream` members are absent on
 * purpose: they are the NDJSON follow-on lines OQ-14(ii) rules, and the stream
 * itself is slice A3. Nothing here pretends they are covered.
 */
const INVOCATIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['runtime.ensure', ['runtime', 'ensure']],
  ['runtime.status', ['runtime', 'status']],
  ['runtime.doctor', ['runtime', 'doctor']],
  ['runtime.stop', ['runtime', 'stop', '--live-runs', 'refuse', '--expect-epoch', EPOCH]],
  ['agent.spawn', ['agent', 'spawn', '--role', 'builder', '--name', 'Nova']],
  ['agent.list', ['agent', 'list']],
  ['agent.tree', ['agent', 'tree', AGENT]],
  ['agent.inspect.run', ['agent', 'inspect', RUN]],
  ['agent.inspect.agent', ['agent', 'inspect', AGENT]],
  ['agent.attach', ['agent', 'attach', RUN]],
  ['agent.interrupt', ['agent', 'interrupt', RUN, '--expect-version', '1']],
  ['agent.stop', ['agent', 'stop', AGENT, '--run', RUN, '--confirm', 'stop-one']],
  ['agent.stop-tree.prepare', ['agent', 'stop-tree', AGENT, '--prepare']],
  ['agent.stop-tree.confirm',
    ['agent', 'stop-tree', AGENT, '--token', 'tok', '--confirm', 'stop-tree']],
  ['agent.continue', ['agent', 'continue', AGENT, '--from', RUN, '--mode', 'resume']],
  ['agent.adopt', ['agent', 'adopt', AGENT, '--supervisor', AGENT, '--expect-version', '1']],
  ['agent.controls', ['agent', 'controls', RUN]],
  ['agent.control', ['agent', 'control', RUN,
    '--expect-version', '1', '--name', 'model', '--value', 'opus']],
  ['agent.message', ['agent', 'message', AGENT, '--text', 'hello']],
  ['agent.communications', ['agent', 'communications', AGENT]],
  ['agent.usage.run', ['agent', 'usage', RUN]],
  ['agent.usage.agent', ['agent', 'usage', AGENT]],
  ['agent.events', ['agent', 'events']],
  ['terminal.list', ['terminal', 'list']],
  ['terminal.inspect', ['terminal', 'inspect', TERMINAL]],
  ['terminal.attach', ['terminal', 'attach', TERMINAL]],
  ['terminal.detach', ['terminal', 'detach', 'attachment_1', '--session', TERMINAL]],
  ['watch.add', ['watch', 'add', '--subject', RUN, '--when', 'run-final',
    '--notify', AGENT, '--delivery', 'queue-only']],
  ['watch.list', ['watch', 'list']],
  ['watch.update', ['watch', 'update', 'watchRule_x', '--when', 'run-final',
    '--expect-version', '1']],
  ['watch.remove', ['watch', 'remove', 'watchRule_x', '--expect-version', '1']],
  ['watch.notifications', ['watch', 'notifications']],
  ['watch.acknowledge', ['watch', 'acknowledge', 'notification_x']],
  ['watch.reset-drift', ['watch', 'reset-drift', 'watchDeadline_x', '--expect-version', '1',
    '--expect-episode', EPISODE, '--reason', 'the agent was waiting on me']],
];

const firstEnvelope = (out: string): { command?: string } =>
  JSON.parse(out.split('\n').find((line) => line.startsWith('{'))!) as { command?: string };

test('every frozen command emits its ruled dotted name', async () => {
  const emitted = await Promise.all(INVOCATIONS.map(async ([expected, argv]) => {
    const { out } = await runNvk(argv);
    return [expected, firstEnvelope(out).command, argv.join(' ')] as const;
  }));
  for (const [expected, actual, argv] of emitted) {
    assert.equal(actual, expected, `nvk ${argv} said "${String(actual)}"`);
  }
});

test('a refusal issued before dispatch still names the command that was typed', async () => {
  // §17.2 refuses a malformed `--client-op-id` before anything runs, which is
  // the one path that must name the command WITHOUT the handler having run.
  // That means two spellings of one answer — the handler's literal and the
  // dispatcher's table — so this drives every command down the early path and
  // asserts they agree. Without it the two drift silently, and the field a
  // consumer branches on becomes a function of which error you hit.
  const refused = await Promise.all(INVOCATIONS.map(async ([expected, argv]) => {
    const { code, out } = await runNvk([...argv, '--client-op-id', 'not-an-op-id']);
    return [expected, firstEnvelope(out).command, code, argv.join(' ')] as const;
  }));
  for (const [expected, actual, , argv] of refused) {
    assert.equal(actual, expected, `nvk ${argv} --client-op-id <bad> said "${String(actual)}"`);
  }
  // Only the exit code differs by CLI, and legitimately: agent/terminal/runtime
  // refuse a malformed id for every verb, while `watch` refuses it inside its
  // mutations — where §17.2 actually puts the flag — and lets its reads ignore
  // a flag they never send. Both refuse before touching the runtime.
  const mutations = refused.filter(([command]) => command.startsWith('watch.')
    && ['watch.add', 'watch.update', 'watch.remove', 'watch.reset-drift'].includes(command));
  for (const [, , code, argv] of mutations) {
    assert.equal(code, 2, `nvk ${argv} --client-op-id <bad> exited ${String(code)}`);
  }
});

test('the two dual-form commands name the operation that actually ran', async () => {
  // OQ-09 and OQ-16: the argument's §4.1 prefix picks the operation AND the
  // value type. Only an `agentRun_` prefix picks the run form (X-3), so the
  // resolution is total — anything else, including nothing at all, is the
  // agent form. Asserted as a pair because the bug this closes is one string
  // for both halves, which looks correct until a consumer has to branch on it.
  const forms = await Promise.all([
    ['agent', 'inspect', RUN], ['agent', 'inspect', AGENT],
    ['agent', 'usage', RUN], ['agent', 'usage', AGENT],
  ].map(async (argv) => firstEnvelope((await runNvk(argv)).out).command));
  assert.deepEqual(forms,
    ['agent.inspect.run', 'agent.inspect.agent', 'agent.usage.run', 'agent.usage.agent']);
});

/**
 * X-1's closed set, transcribed from the ruling in its published order. This is
 * the ruling's own text, not a derivation — the shipped constant is checked
 * AGAINST it, never generated from it.
 */
const PUBLISHED: readonly string[] = [
  'runtime.ensure', 'runtime.status', 'runtime.doctor', 'runtime.stop',
  'agent.spawn', 'agent.list', 'agent.tree',
  'agent.inspect.run', 'agent.inspect.agent',
  'agent.attach', 'agent.attach.stream',
  'agent.interrupt', 'agent.stop', 'agent.stop-tree.prepare', 'agent.stop-tree.confirm',
  'agent.continue', 'agent.adopt', 'agent.controls', 'agent.control', 'agent.message',
  'agent.communications', 'agent.usage.run', 'agent.usage.agent', 'agent.events',
  'terminal.list', 'terminal.inspect', 'terminal.attach', 'terminal.attach.stream',
  'terminal.detach',
  'watch.add', 'watch.list', 'watch.update', 'watch.remove',
  'watch.notifications', 'watch.acknowledge', 'watch.reset-drift',
];

test('the shipped vocabulary is X-1 closed set, verbatim and in order', () => {
  assert.deepEqual([...RULED_COMMANDS], PUBLISHED);
});

test('no ruled command is the raw argv form', () => {
  // The failure this guards against is a call site that "helpfully" passes the
  // user's own words through. `command` is a published enum in all but name;
  // an argv echo would make it unusable as a discriminator.
  for (const command of RULED_COMMANDS) {
    assert.ok(!command.includes(' '), `${command} carries the space form`);
    assert.match(command, /^(runtime|agent|terminal|watch)\.[a-z-]+(\.[a-z-]+)?$/u);
  }
});
