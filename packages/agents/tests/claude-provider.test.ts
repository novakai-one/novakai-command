// B1b slice 2 — the CLAUDE provider adapter (DEC-B1-4/DEC-B1-5).
//
// A FAKE `claude` executable per test, so the argv contract, the per-message
// process model and the `--resume` mechanism are asserted against ACTUAL
// process invocations.
//
// The fake replies in the stream-json shape verified LIVE against Claude Code
// 2.1.219 on 2026-07-28 (`claude -p … --output-format stream-json --verbose`):
//   {"type":"system","subtype":"init","session_id":"51974ac1-…",…}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}],
//                                  "usage":{…}},"session_id":"…"}
//   {"type":"result","subtype":"success","result":"…","session_id":"…",
//     "usage":{"input_tokens":2,"output_tokens":10,
//              "cache_read_input_tokens":23684,"cache_creation_input_tokens":21002}}
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudeCliRuntime } from '../core/providers/claude.js';

function fakeClaude(options: {
  reply?: string; exitCode?: number; sessionId?: string; usage?: object; noResult?: boolean;
} = {}): { cliPath: string; invocations: () => string[][] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-claude-'));
  const cliPath = path.join(dir, 'claude');
  const logPath = path.join(dir, 'invocations.log');
  const reply = options.reply ?? 'hello from fake claude';
  const sessionId = options.sessionId ?? '51974ac1-56a4-4082-ab26-b6efdf923aaf';
  const exitCode = options.exitCode ?? 0;
  const usage = options.usage ?? {
    input_tokens: 2, output_tokens: 10,
    cache_read_input_tokens: 23684, cache_creation_input_tokens: 21002,
  };
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (${exitCode} !== 0) { process.stderr.write('fake claude failure\\n'); process.exit(${exitCode}); }
const sid = ${JSON.stringify(sessionId)};
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'hook_started', session_id: sid }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(reply)} }] } }) + '\\n');
${options.noResult ? '' : `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: ${JSON.stringify(reply)}, usage: ${JSON.stringify(usage)} }) + '\\n');`}
`);
  chmodSync(cliPath, 0o755);
  return {
    cliPath,
    invocations: () => (existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      : []),
  };
}

test('one user message = one `claude -p` process; only assistant text reaches onData', async () => {
  const fake = fakeClaude({ reply: 'probe-ok' });
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  const seen: string[] = [];
  runtime.onData((_key: string, data: string) => seen.push(data));

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_a' });
  assert.equal(runtime.write('sess_a', 'hi'), true);
  await runtime.drain('sess_a');

  assert.deepEqual(seen, ['probe-ok'],
    'the result line repeats the reply — emitting both would double-post it to Chris');
  const argv = fake.invocations();
  assert.equal(argv.length, 1, 'exactly one process per message');
  assert.deepEqual(argv[0], ['-p', 'hi', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(runtime.list(), [{ agentId: 'sess_a', status: 'running' }],
    'the LOGICAL session outlives the physical process');
});

test('turn 2 resumes the conversation with --resume, learned from the session_id', async () => {
  const fake = fakeClaude({ sessionId: 'sess-uuid-abc' });
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_b' });

  runtime.write('sess_b', 'first');
  await runtime.drain('sess_b');
  runtime.write('sess_b', 'second');
  await runtime.drain('sess_b');

  const argv = fake.invocations();
  assert.equal(argv.length, 2);
  assert.equal(argv[0]!.includes('--resume'), false, 'turn 1 has no conversation to resume');
  assert.deepEqual(argv[1],
    ['-p', 'second', '--output-format', 'stream-json', '--verbose', '--resume', 'sess-uuid-abc']);
  assert.equal(runtime.resumeHint('sess_b'), 'sess-uuid-abc',
    'the resumable handle is readable — the session registry persists it (DEC-B1-6)');
});

test("model rule: 'cli-default' passes NO --model flag; an alias does (red gate 3)", async () => {
  const fake = fakeClaude();
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_default', model: 'cli-default' });
  runtime.write('sess_default', 'x');
  await runtime.drain('sess_default');
  assert.equal(fake.invocations()[0]!.includes('--model'), false);

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_aliased', model: 'opus' });
  runtime.write('sess_aliased', 'y');
  await runtime.drain('sess_aliased');
  const aliased = fake.invocations()[1]!;
  assert.equal(aliased[aliased.indexOf('--model') + 1], 'opus');
});

test('claude has NO mid-session model mechanism — the runtime declares none (OD-C3)', () => {
  const fake = fakeClaude();
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  assert.equal((runtime as { setModel?: unknown }).setModel, undefined,
    'absence of setModel is what produces the typed UnsupportedOperation upstream');
});

test('the result line supplies per-turn usage, flagged NOT cumulative', async () => {
  const fake = fakeClaude({
    usage: {
      input_tokens: 2, output_tokens: 10,
      cache_read_input_tokens: 23684, cache_creation_input_tokens: 21002,
    },
  });
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  const turns: Array<{ usage: unknown }> = [];
  runtime.onTurn((r) => turns.push(r));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_u' });

  runtime.write('sess_u', 'count me');
  await runtime.drain('sess_u');

  assert.deepEqual(turns[0]!.usage, {
    inputTokens: 2, outputTokens: 10, cacheReadTokens: 23684, cacheCreationTokens: 21002,
    cumulative: false,
  }, 'unlike codex, claude reports the TURN — no baseline subtraction');
});

test('a turn that ends without a result line still reports the assistant-message usage', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-claude-noresult-'));
  const cliPath = path.join(dir, 'claude');
  writeFileSync(cliPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial' }], usage: { input_tokens: 5, output_tokens: 6 } } }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath });
  const turns: Array<{ usage: { inputTokens: number; outputTokens: number } | null }> = [];
  runtime.onTurn((r) => turns.push(r));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_nr' });
  runtime.write('sess_nr', 'x');
  await runtime.drain('sess_nr');

  assert.equal(turns[0]!.usage!.inputTokens, 5);
  assert.equal(turns[0]!.usage!.outputTokens, 6,
    'an interrupted stream reports what it did report, rather than nothing');
});

test('a turn with no usage anywhere reports usage: null — absent, never invented', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-claude-nousage-'));
  const cliPath = path.join(dir, 'claude');
  writeFileSync(cliPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'quiet' }] } }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath });
  const turns: Array<{ usage: unknown }> = [];
  runtime.onTurn((r) => turns.push(r));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_nu' });
  runtime.write('sess_nu', 'x');
  await runtime.drain('sess_nu');
  assert.equal(turns[0]!.usage, null);
});

test('tool_use blocks are not user-facing; only text blocks are emitted, joined', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-claude-tools-'));
  const cliPath = path.join(dir, 'claude');
  writeFileSync(cliPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [
  { type: 'text', text: 'part one ' },
  { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
  { type: 'text', text: 'part two' },
] } }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath });
  const seen: string[] = [];
  runtime.onData((_k: string, d: string) => seen.push(d));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_t' });
  runtime.write('sess_t', 'x');
  await runtime.drain('sess_t');

  assert.deepEqual(seen, ['part one part two'],
    "the agent's tool calls are its internals, never Chris's thread");
});

test('a non-zero CLI exit is surfaced as text and the logical session stays usable', async () => {
  const fake = fakeClaude({ exitCode: 3 });
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  const seen: string[] = [];
  runtime.onData((_k: string, d: string) => seen.push(d));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_d' });

  runtime.write('sess_d', 'boom');
  await runtime.drain('sess_d');

  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /exited with code 3/);
  assert.match(seen[0]!, /fake claude failure/, 'stderr tail is included, never swallowed');
  assert.equal(runtime.list()[0]!.status, 'running');
});

test('messages are serialized: one child process at a time, in order', async () => {
  const fake = fakeClaude();
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_e' });

  runtime.write('sess_e', 'a');
  runtime.write('sess_e', 'b');
  runtime.write('sess_e', 'c');
  await runtime.drain('sess_e');

  const prompts = fake.invocations().map((argv) => argv[argv.indexOf('-p') + 1]);
  assert.deepEqual(prompts, ['a', 'b', 'c']);
});

test('kill ends the logical session and cancels every prompt still queued behind it', async () => {
  const fake = fakeClaude();
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  const exits: Array<[string, number | null]> = [];
  runtime.onExit((k: string, code: number | null) => exits.push([k, code]));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_g' });
  let completed = 0;
  runtime.onTurn(() => { completed += 1; if (completed === 1) runtime.kill('sess_g'); });

  runtime.write('sess_g', 'first');
  runtime.write('sess_g', 'must never spawn');
  await runtime.drain('sess_g');

  assert.deepEqual(fake.invocations().map((a) => a[a.indexOf('-p') + 1]), ['first']);
  assert.equal(runtime.write('sess_g', 'ignored'), false);
  assert.deepEqual(exits, [['sess_g', null]]);
});

test('spawn config is honored per message: argv is prepended, env is merged', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-claude-env-'));
  const cliPath = path.join(dir, 'claude');
  const logPath = path.join(dir, 'env.log');
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify([process.argv.slice(2), process.env.NOVAKAI_SKILLS || '']) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath });
  await runtime.create({
    cwd: process.cwd(), agentId: 'sess_f',
    argv: ['--add-dir', '/tmp/skills'], env: { NOVAKAI_SKILLS: '/tmp/skills' },
  });
  runtime.write('sess_f', 'hi');
  await runtime.drain('sess_f');

  const [argv, skills] = JSON.parse(readFileSync(logPath, 'utf8').trim()) as [string[], string];
  assert.deepEqual(argv, ['--add-dir', '/tmp/skills', '-p', 'hi', '--output-format', 'stream-json', '--verbose']);
  assert.equal(skills, '/tmp/skills', 'the declared skills env mechanism reaches the process');
});

test('adopt rebinds a session to a known conversation after a restart', async () => {
  const fake = fakeClaude();
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  runtime.adopt('sess_restored', { cliSessionId: 'conv_survived', model: 'cli-default' });

  assert.deepEqual(runtime.list(), [{ agentId: 'sess_restored', status: 'running' }]);
  runtime.write('sess_restored', 'after the restart');
  await runtime.drain('sess_restored');
  const argv = fake.invocations()[0]!;
  assert.equal(argv[argv.indexOf('--resume') + 1], 'conv_survived',
    'nothing was attached TO — the next send spawns a fresh process carrying the resume id');
});

test('an unavailable CLI is a typed refusal at create, not a mystery later', async () => {
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: '/definitely/not/here/claude' });
  assert.equal(runtime.isAvailable(), false);
  await assert.rejects(() => runtime.create({ cwd: process.cwd(), agentId: 'sess_h' }), /claude CLI not found/);
});

test('create with a duplicate session key throws (the terminal registry rule)', async () => {
  const fake = fakeClaude();
  const runtime = createClaudeCliRuntime({ cwd: process.cwd(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_dupe' });
  await assert.rejects(
    () => runtime.create({ cwd: process.cwd(), agentId: 'sess_dupe' }),
    /already exists/,
  );
});
