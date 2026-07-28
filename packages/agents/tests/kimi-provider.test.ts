// B1a slice 3 — the kimi provider adapter promoted into packages/agents
// (DEC-B1-4/DEC-B1-5). Provider-specific code lives ONLY here (red gate C1).
//
// The tests drive a FAKE kimi CLI (a real executable written per test) so the
// argv contract, the per-message process model and the `-S` resume mechanism
// are asserted against actual process invocations, not mocks of our own code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKimiCliRuntime, defaultKimiCliPath } from '../core/providers/kimi.js';

/**
 * Writes a fake `kimi` executable that logs its argv (one JSON array per
 * invocation) and replies in the real stream-json shape verified against
 * kimi 0.29.1 on 2026-07-28.
 */
function fakeKimi(options: { reply?: string; exitCode?: number; sessionId?: string } = {}): {
  cliPath: string; logPath: string; invocations: () => string[][];
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-kimi-'));
  const cliPath = path.join(dir, 'kimi');
  const logPath = path.join(dir, 'invocations.log');
  const reply = options.reply ?? 'hello from fake kimi';
  const sessionId = options.sessionId ?? 'session_fake_1';
  const exitCode = options.exitCode ?? 0;
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (${exitCode} !== 0) { process.stderr.write('fake kimi failure\\n'); process.exit(${exitCode}); }
process.stdout.write(JSON.stringify({ role: 'assistant', content: ${JSON.stringify(reply)} }) + '\\n');
process.stdout.write(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: ${JSON.stringify(sessionId)} }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  return {
    cliPath, logPath,
    invocations: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
  };
}

/** Deterministic quiescence: the runtime's own drain(), never a sleep. */

test('one user message = one child process that exits; the assistant text reaches onData', async () => {
  const fake = fakeKimi({ reply: 'probe-ok' });
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  const seen: string[] = [];
  runtime.onData((_key: string, data: string) => seen.push(data));

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_a' });
  assert.equal(runtime.write('sess_a', 'hi'), true);
  await runtime.drain('sess_a');

  assert.deepEqual(seen, ['probe-ok'], 'only assistant content is user-facing');
  const argv = fake.invocations();
  assert.equal(argv.length, 1, 'exactly one process per message');
  assert.deepEqual(argv[0], ['-p', 'hi', '--output-format', 'stream-json']);
  assert.deepEqual(runtime.list(), [{ agentId: 'sess_a', status: 'running' }],
    'the LOGICAL session outlives the physical process');
});

test('turn 2 resumes the CLI conversation with -S, learned from the resume_hint meta line', async () => {
  const fake = fakeKimi({ sessionId: 'session_abc' });
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_b' });

  runtime.write('sess_b', 'first');
  await runtime.drain('sess_b');
  runtime.write('sess_b', 'second');
  await runtime.drain('sess_b');

  const argv = fake.invocations();
  assert.equal(argv.length, 2);
  assert.equal(argv[0]!.includes('-S'), false, 'turn 1 has no conversation to resume');
  assert.deepEqual(argv[1], ['-p', 'second', '--output-format', 'stream-json', '-S', 'session_abc']);
  assert.equal(runtime.resumeHint('sess_b'), 'session_abc',
    'the resumable handle is readable — the session registry persists it (DEC-B1-6)');
});

test("model rule: 'cli-default' passes NO -m flag; a configured alias does (red gate 3)", async () => {
  const fake = fakeKimi();
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_default', model: 'cli-default' });
  runtime.write('sess_default', 'x');
  await runtime.drain('sess_default');
  assert.equal(fake.invocations()[0]!.includes('-m'), false,
    "'cli-default' means: let the CLI use the user's own config.toml model");

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_aliased', model: 'k2' });
  runtime.write('sess_aliased', 'y');
  await runtime.drain('sess_aliased');
  const aliased = fake.invocations()[1]!;
  assert.equal(aliased[aliased.indexOf('-m') + 1], 'k2');
});

test('setModel switches the model for subsequent turns (OD-C3: sticky per CLI session)', async () => {
  const fake = fakeKimi();
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_c', model: 'cli-default' });

  runtime.write('sess_c', 'one');
  await runtime.drain('sess_c');
  assert.equal(runtime.setModel!('sess_c', 'k2-turbo'), true);
  runtime.write('sess_c', 'two');
  await runtime.drain('sess_c');

  const [first, second] = fake.invocations();
  assert.equal(first!.includes('-m'), false);
  assert.equal(second![second!.indexOf('-m') + 1], 'k2-turbo');
  assert.equal(runtime.setModel!('sess_nope', 'k2'), false, 'unknown session = false, never a throw');
});

test('a non-zero CLI exit is surfaced as text and the logical session stays usable', async () => {
  const fake = fakeKimi({ exitCode: 3 });
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  const seen: string[] = [];
  runtime.onData((_k: string, d: string) => seen.push(d));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_d' });

  runtime.write('sess_d', 'boom');
  await runtime.drain('sess_d');

  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /exited with code 3/);
  assert.match(seen[0]!, /fake kimi failure/, 'stderr tail is included, never swallowed');
  assert.equal(runtime.list()[0]!.status, 'running');
});

test('messages are serialized: one child process at a time, in order', async () => {
  const fake = fakeKimi();
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_e' });

  runtime.write('sess_e', 'a');
  runtime.write('sess_e', 'b');
  runtime.write('sess_e', 'c');
  await runtime.drain('sess_e');

  const prompts = fake.invocations().map((argv) => argv[argv.indexOf('-p') + 1]);
  assert.deepEqual(prompts, ['a', 'b', 'c']);
});

test('spawn config is honored per message: skills argv is prepended, env is merged', async () => {
  const fake = fakeKimi();
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  await runtime.create({
    cwd: process.cwd(), agentId: 'sess_f',
    argv: ['--skills-dir', '/tmp/skills'], env: { NVK_TEST: '1' },
  });
  runtime.write('sess_f', 'hi');
  await runtime.drain('sess_f');

  assert.deepEqual(fake.invocations()[0], ['--skills-dir', '/tmp/skills', '-p', 'hi', '--output-format', 'stream-json']);
});

test('kill ends the logical session; writes afterwards are refused, never thrown', async () => {
  const fake = fakeKimi();
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  const exits: Array<[string, number | null]> = [];
  runtime.onExit((k: string, code: number | null) => exits.push([k, code]));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_g' });

  assert.equal(runtime.kill('sess_g'), true);
  assert.equal(runtime.write('sess_g', 'ignored'), false);
  await runtime.drain('sess_g');
  assert.equal(fake.invocations().length, 0);
  assert.deepEqual(exits, [['sess_g', null]]);
});

test('an unavailable CLI is a typed refusal at create, not a mystery later', async () => {
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: '/definitely/not/here/kimi' });
  assert.equal(runtime.isAvailable(), false);
  await assert.rejects(() => runtime.create({ cwd: process.cwd(), agentId: 'sess_h' }), /kimi CLI not found/);
  assert.ok(defaultKimiCliPath().endsWith(path.join('.kimi-code', 'bin', 'kimi')));
});

// Ported from the deleted shell demo suite (packages/shell/tests/kimi-cli-runtime.test.ts):
// the coverage moves with the code it guards, it does not evaporate.
test('create with a duplicate session key throws (the terminal registry rule)', async () => {
  const fake = fakeKimi();
  const runtime = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_dupe' });
  await assert.rejects(
    () => runtime.create({ cwd: process.cwd(), agentId: 'sess_dupe' }),
    /already exists/,
    'a second spawn can never silently take over the first session',
  );
});
