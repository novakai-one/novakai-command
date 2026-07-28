// B1b slice 1 — the CODEX provider adapter (DEC-B1-4/DEC-B1-5).
//
// Like the kimi suite, these tests drive a FAKE `codex` executable written per
// test, so the argv contract, the per-message process model and the
// `codex exec resume` mechanism are asserted against ACTUAL process
// invocations — never against mocks of our own code.
//
// The fake replies in the JSONL event shape verified live against
// codex-cli 0.144.5 on 2026-07-28 (`codex exec --json`):
//   {"type":"thread.started","thread_id":"019f…"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
//   {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,
//                                     "output_tokens":…,"reasoning_output_tokens":…}}
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexCliRuntime } from '../core/providers/codex.js';

function fakeCodex(options: { reply?: string; exitCode?: number; threadId?: string; usage?: object } = {}): {
  cliPath: string; invocations: () => string[][];
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-codex-'));
  const cliPath = path.join(dir, 'codex');
  const logPath = path.join(dir, 'invocations.log');
  const reply = options.reply ?? 'hello from fake codex';
  const threadId = options.threadId ?? '019fa7b4-8cbd-7231-8b7f-0905efa938b5';
  const exitCode = options.exitCode ?? 0;
  const usage = options.usage ?? {
    input_tokens: 1200, cached_input_tokens: 300, output_tokens: 42, reasoning_output_tokens: 8,
  };
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (${exitCode} !== 0) { process.stderr.write('fake codex failure\\n'); process.exit(${exitCode}); }
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(threadId)} }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'item_r', type: 'reasoning', text: 'thinking' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: ${JSON.stringify(reply)} } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: ${JSON.stringify(usage)} }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  return {
    cliPath,
    invocations: () => (existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      : []),
  };
}

/** A cwd that is NOT inside a git repo, so the git-repo rule is observable. */
function nonGitDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'codex-nongit-'));
}

/** A cwd that IS a git repo (a bare `.git` dir is enough for our detection). */
function gitDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-git-'));
  mkdirSync(path.join(dir, '.git'));
  return dir;
}

test('one user message = one `codex exec` process; only agent_message text reaches onData', async () => {
  const fake = fakeCodex({ reply: 'probe-ok' });
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  const seen: string[] = [];
  runtime.onData((_key: string, data: string) => seen.push(data));

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_a' });
  assert.equal(runtime.write('sess_a', 'hi'), true);
  await runtime.drain('sess_a');

  assert.deepEqual(seen, ['probe-ok'], 'reasoning items are not user-facing; agent_message is');
  const argv = fake.invocations();
  assert.equal(argv.length, 1, 'exactly one process per message');
  assert.deepEqual(argv[0], ['exec', '--json', 'hi']);
  assert.deepEqual(runtime.list(), [{ agentId: 'sess_a', status: 'running' }],
    'the LOGICAL session outlives the physical process');
});

test('turn 2 resumes the codex thread via `exec resume <thread_id>` (OD-B1-1 closed)', async () => {
  const fake = fakeCodex({ threadId: 'thread_abc' });
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_b' });

  runtime.write('sess_b', 'first');
  await runtime.drain('sess_b');
  runtime.write('sess_b', 'second');
  await runtime.drain('sess_b');

  const argv = fake.invocations();
  assert.equal(argv.length, 2);
  assert.deepEqual(argv[0], ['exec', '--json', 'first'], 'turn 1 has no thread to resume');
  assert.deepEqual(argv[1], ['exec', 'resume', '--json', 'thread_abc', 'second']);
  assert.equal(runtime.resumeHint('sess_b'), 'thread_abc',
    'the resumable handle is readable — the session registry persists it (DEC-B1-6)');
});

test("model rule: 'cli-default' passes NO -m flag; a configured alias does (red gate 3)", async () => {
  const fake = fakeCodex();
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_default', model: 'cli-default' });
  runtime.write('sess_default', 'x');
  await runtime.drain('sess_default');
  assert.equal(fake.invocations()[0]!.includes('-m'), false,
    "'cli-default' means: let codex use the user's own config.toml model");

  await runtime.create({ cwd: process.cwd(), agentId: 'sess_aliased', model: 'gpt-5.1-codex' });
  runtime.write('sess_aliased', 'y');
  await runtime.drain('sess_aliased');
  const aliased = fake.invocations()[1]!;
  assert.equal(aliased[aliased.indexOf('-m') + 1], 'gpt-5.1-codex');
});

test('codex has NO mid-session model mechanism — the runtime declares none (OD-C3)', () => {
  const fake = fakeCodex();
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  assert.equal((runtime as { setModel?: unknown }).setModel, undefined,
    'absence of setModel is what produces the typed UnsupportedOperation upstream');
});

test('a non-git cwd gets --skip-git-repo-check; a git cwd does not (HANDOVER git-repo rule)', async () => {
  const fake = fakeCodex();
  const outside = createCodexCliRuntime({ cwd: nonGitDir(), cliPath: fake.cliPath });
  await outside.create({ cwd: nonGitDir(), agentId: 'sess_nogit' });
  outside.write('sess_nogit', 'q');
  await outside.drain('sess_nogit');
  assert.ok(fake.invocations()[0]!.includes('--skip-git-repo-check'),
    'outside a repo codex refuses without the flag — degrade honestly, never opaquely');

  const fake2 = fakeCodex();
  const inside = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake2.cliPath });
  await inside.create({ cwd: gitDir(), agentId: 'sess_git' });
  inside.write('sess_git', 'q');
  await inside.drain('sess_git');
  assert.equal(fake2.invocations()[0]!.includes('--skip-git-repo-check'), false);
});

// LIVE-MEASURED 2026-07-28 (codex-cli 0.144.5), two turns of one thread:
//   turn 1  stream turn.completed.usage.input_tokens = 21312
//           rollout total_token_usage = 21312   last_token_usage = 21312
//   turn 2  stream turn.completed.usage.input_tokens = 45338
//           rollout total_token_usage = 45338   last_token_usage = 24026
// The stream number tracks TOTAL, not LAST. Reporting it as a turn cost would
// overstate turn 2 by 21312 tokens and grow with every turn.
test('turn.completed usage is flagged CUMULATIVE — codex streams the session total, not the turn', async () => {
  const fake = fakeCodex({
    usage: { input_tokens: 1000, cached_input_tokens: 250, output_tokens: 40, reasoning_output_tokens: 7 },
  });
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  const turns: Array<{ usage: unknown }> = [];
  runtime.onTurn((r) => turns.push(r));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_u' });

  runtime.write('sess_u', 'count me');
  await runtime.drain('sess_u');

  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]!.usage, {
    inputTokens: 1000, outputTokens: 47, cacheReadTokens: 250, cacheCreationTokens: 0,
    cumulative: true,
  }, 'cumulative=true is what makes the usage table subtract a baseline instead of adding bills up');
});

test('two codex turns report RISING cumulative totals — the delta, not the sum, is the cost', async () => {
  // The fake escalates exactly the way the real CLI did (21312 → 45338).
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-codex-cumul-'));
  const cliPath = path.join(dir, 'codex');
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const counter = ${JSON.stringify(path.join(dir, 'n'))};
let n = 0; try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch {}
n += 1; fs.writeFileSync(counter, String(n));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'turn ' + n } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: n === 1 ? 21312 : 45338, cached_input_tokens: 0, output_tokens: n === 1 ? 9 : 16, reasoning_output_tokens: 0 } }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath });
  const totals: number[] = [];
  runtime.onTurn((r) => totals.push(r.usage!.inputTokens));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_cum' });
  runtime.write('sess_cum', 'one');
  await runtime.drain('sess_cum');
  runtime.write('sess_cum', 'two');
  await runtime.drain('sess_cum');

  assert.deepEqual(totals, [21312, 45338], 'the numbers RISE — summing them would bill 66650 for 45338');
});

test('a turn with no usage event reports usage: null — absent, never invented', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-codex-nousage-'));
  const cliPath = path.join(dir, 'codex');
  writeFileSync(cliPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'no usage here' } }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath });
  const turns: Array<{ usage: unknown }> = [];
  runtime.onTurn((r) => turns.push(r));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_nu' });
  runtime.write('sess_nu', 'x');
  await runtime.drain('sess_nu');
  assert.equal(turns[0]!.usage, null);
});

test('a non-zero CLI exit is surfaced as text and the logical session stays usable', async () => {
  const fake = fakeCodex({ exitCode: 3 });
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  const seen: string[] = [];
  runtime.onData((_k: string, d: string) => seen.push(d));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_d' });

  runtime.write('sess_d', 'boom');
  await runtime.drain('sess_d');

  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /exited with code 3/);
  assert.match(seen[0]!, /fake codex failure/, 'stderr tail is included, never swallowed');
  assert.equal(runtime.list()[0]!.status, 'running');
});

test('messages are serialized: one child process at a time, in order', async () => {
  const fake = fakeCodex();
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_e' });

  runtime.write('sess_e', 'a');
  runtime.write('sess_e', 'b');
  runtime.write('sess_e', 'c');
  await runtime.drain('sess_e');

  const prompts = fake.invocations().map((argv) => argv[argv.length - 1]);
  assert.deepEqual(prompts, ['a', 'b', 'c']);
});

test('kill ends the logical session and cancels every prompt still queued behind it', async () => {
  const fake = fakeCodex();
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  const exits: Array<[string, number | null]> = [];
  runtime.onExit((k: string, code: number | null) => exits.push([k, code]));
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_g' });
  let completed = 0;
  runtime.onTurn(() => { completed += 1; if (completed === 1) runtime.kill('sess_g'); });

  runtime.write('sess_g', 'first');
  runtime.write('sess_g', 'must never spawn');
  await runtime.drain('sess_g');

  assert.deepEqual(fake.invocations().map((a) => a[a.length - 1]), ['first']);
  assert.equal(runtime.write('sess_g', 'ignored'), false);
  assert.deepEqual(exits, [['sess_g', null]]);
});

test('spawn config is honored per message: argv is prepended, env is merged', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-codex-env-'));
  const cliPath = path.join(dir, 'codex');
  const logPath = path.join(dir, 'env.log');
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify([process.argv.slice(2), process.env.NOVAKAI_SKILLS || '']) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath });
  await runtime.create({
    cwd: gitDir(), agentId: 'sess_f',
    argv: ['--profile', 'novakai'], env: { NOVAKAI_SKILLS: '/tmp/skills' },
  });
  runtime.write('sess_f', 'hi');
  await runtime.drain('sess_f');

  const [argv, skills] = JSON.parse(readFileSync(logPath, 'utf8').trim()) as [string[], string];
  assert.deepEqual(argv, ['--profile', 'novakai', 'exec', '--json', 'hi']);
  assert.equal(skills, '/tmp/skills', 'the declared skills env mechanism reaches the process');
});

test('adopt rebinds a session to a known thread after a restart; the next turn resumes it', async () => {
  const fake = fakeCodex();
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  runtime.adopt('sess_restored', { cliSessionId: 'thread_survived', model: 'cli-default' });

  assert.deepEqual(runtime.list(), [{ agentId: 'sess_restored', status: 'running' }]);
  runtime.write('sess_restored', 'after the restart');
  await runtime.drain('sess_restored');
  assert.deepEqual(fake.invocations()[0],
    ['exec', 'resume', '--json', 'thread_survived', 'after the restart'],
    'nothing was attached TO — the next send spawns a fresh process carrying the resume id');
});

test('an unavailable CLI is a typed refusal at create, not a mystery later', async () => {
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: '/definitely/not/here/codex' });
  assert.equal(runtime.isAvailable(), false);
  await assert.rejects(() => runtime.create({ cwd: process.cwd(), agentId: 'sess_h' }), /codex CLI not found/);
});

test('create with a duplicate session key throws (the terminal registry rule)', async () => {
  const fake = fakeCodex();
  const runtime = createCodexCliRuntime({ cwd: gitDir(), cliPath: fake.cliPath });
  await runtime.create({ cwd: process.cwd(), agentId: 'sess_dupe' });
  await assert.rejects(
    () => runtime.create({ cwd: process.cwd(), agentId: 'sess_dupe' }),
    /already exists/,
    'a second spawn can never silently take over the first session',
  );
});
