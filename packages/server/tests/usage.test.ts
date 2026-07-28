// B1b slice 4 — real per-session token accounting (DEC-B1-11 + the codex
// cumulative calibration).
//
// The parsers are ported from Kimi-Work/scripts/agent-watchdog.mjs, which stays
// READ-ONLY per §13 disposition 1. Every fixture below is the SHAPE MEASURED on
// disk on 2026-07-28 from the real CLIs, not a shape we wish they had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageReader, parseCodexRollout, parseClaudeTranscript, parseKimiWire } from '../core/supervision/usage.js';

const jsonl = (dir: string, name: string, lines: object[]): string => {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};

// ── parsers ────────────────────────────────────────────────────────────────

test('codex rollout: the LAST total_token_usage wins — token_count events are cumulative', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-roll-'));
  // Verbatim shape from a real two-turn thread (rollout-…-019fa7b4….jsonl).
  const file = jsonl(dir, 'rollout-x.jsonl', [
    { timestamp: '2026-07-28T07:50:55.749Z', type: 'session_meta', payload: { session_id: 'x' } },
    {
      timestamp: '2026-07-28T07:50:58.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 21312, cached_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 0 },
          last_token_usage: { input_tokens: 21312, cached_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 0 },
        },
      },
    },
    {
      timestamp: '2026-07-28T07:55:12.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 45338, cached_input_tokens: 20224, output_tokens: 16, reasoning_output_tokens: 0 },
          last_token_usage: { input_tokens: 24026, cached_input_tokens: 20224, output_tokens: 7, reasoning_output_tokens: 0 },
        },
      },
    },
  ]);

  const parsed = parseCodexRollout(file);
  assert.ok(parsed);
  assert.equal(parsed.cumulative, true, 'codex totals are a running session figure');
  assert.equal(parsed.inputTokens, 45338, 'summing the two events would bill 66650 — the bug this test exists for');
  assert.equal(parsed.outputTokens, 16);
  assert.equal(parsed.cacheReadTokens, 20224);
  assert.equal(parsed.lastActivityAt, '2026-07-28T07:55:12.000Z');
});

test('claude transcript: per-message usage summed, deduped by message id', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-tr-'));
  const usage = {
    input_tokens: 2, output_tokens: 10,
    cache_read_input_tokens: 23684, cache_creation_input_tokens: 21002,
  };
  const file = jsonl(dir, 'sess.jsonl', [
    { timestamp: '2026-07-28T07:50:51.812Z', message: { id: 'msg_1', usage } },
    // The SAME assistant message repeats across lines in a real transcript;
    // counting it twice would double every claude bill.
    { timestamp: '2026-07-28T07:50:51.900Z', message: { id: 'msg_1', usage } },
    { timestamp: '2026-07-28T07:52:00.000Z', message: { id: 'msg_2', usage: { input_tokens: 5, output_tokens: 7 } } },
  ]);

  const parsed = parseClaudeTranscript(file);
  assert.ok(parsed);
  assert.equal(parsed.cumulative, false, 'claude reports per-message costs — nothing to subtract');
  assert.equal(parsed.inputTokens, 7, '2 + 5, not 2 + 2 + 5');
  assert.equal(parsed.outputTokens, 17);
  assert.equal(parsed.cacheReadTokens, 23684);
  assert.equal(parsed.cacheCreationTokens, 21002);
  assert.equal(parsed.lastActivityAt, '2026-07-28T07:52:00.000Z');
});

test('kimi wire.jsonl: step.end usage records summed (the source B1a found)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kimi-wire-'));
  const file = jsonl(dir, 'wire.jsonl', [
    {
      time: 1785225000000, type: 'context.append_loop_event',
      event: { type: 'step.end', usage: { inputOther: 100, output: 20, inputCacheRead: 28160, inputCacheCreation: 5 } },
    },
    {
      time: 1785225600000, type: 'context.append_loop_event',
      event: { type: 'step.end', usage: { inputOther: 50, output: 8, inputCacheRead: 10, inputCacheCreation: 0 } },
    },
    // A non-usage line is still ACTIVITY: liveness must not depend on the
    // agent having spent tokens (a session reading files is alive).
    { time: 1785225700000, type: 'something.else' },
  ]);

  const parsed = parseKimiWire(file);
  assert.ok(parsed);
  assert.equal(parsed.cumulative, false);
  assert.equal(parsed.inputTokens, 150);
  assert.equal(parsed.outputTokens, 28);
  assert.equal(parsed.cacheReadTokens, 28170);
  assert.equal(parsed.cacheCreationTokens, 5);
  assert.equal(parsed.lastActivityAt, new Date(1785225700000).toISOString(),
    'the NEWEST line, usage-bearing or not — this is the liveness signal');
});

test('an unreadable or missing transcript reports null — never zero', () => {
  assert.equal(parseCodexRollout('/definitely/not/here.jsonl'), null);
  assert.equal(parseClaudeTranscript('/definitely/not/here.jsonl'), null);
  assert.equal(parseKimiWire('/definitely/not/here.jsonl'), null);
});

test('a corrupt line is skipped, not fatal — a half-written tail never blanks a table', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-corrupt-'));
  const file = path.join(dir, 'sess.jsonl');
  writeFileSync(file,
    `${JSON.stringify({ timestamp: '2026-07-28T01:00:00.000Z', message: { id: 'm1', usage: { input_tokens: 9, output_tokens: 3 } } })}\n`
    + '{"message": {"id": "m2", "usa\n');
  const parsed = parseClaudeTranscript(file);
  assert.ok(parsed);
  assert.equal(parsed.inputTokens, 9);
});

// ── the reader: transcript discovery + codex baseline calibration ───────────

/** A fake provider home holding all three transcript layouts. */
function providerHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'nvk-provider-home-'));
  return home;
}

test('the reader finds a codex rollout by thread id and reports its cumulative total', () => {
  const home = providerHome();
  jsonl(path.join(home, '.codex', 'sessions', '2026', '07', '28'),
    'rollout-2026-07-28T17-50-55-thread_abc.jsonl', [
      { timestamp: '2026-07-28T07:50:58.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 20 } } } },
    ]);
  const reader = createUsageReader({ home });

  const row = reader.read({
    sessionId: 'sess_1', provider: 'codex', providerConversationId: 'thread_abc', cwd: '/tmp',
  });
  assert.equal(row.basis, 'transcript');
  assert.equal(row.providerTotal?.inputTokens, 500);
});

test('a codex thread NOVAKAI created is billed in full — baseline zero, nothing lost', () => {
  const home = providerHome();
  const dir = path.join(home, '.codex', 'sessions', '2026', '07', '28');
  jsonl(dir, 'rollout-a-thread_new.jsonl', [
    { payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 21312, output_tokens: 9 } } } },
  ]);
  const reader = createUsageReader({ home });
  // Registered at spawn with NO conversation id: the thread did not exist yet.
  reader.trackSession('sess_new', { threadPreexisting: false });

  const row = reader.read({
    sessionId: 'sess_new', provider: 'codex', providerConversationId: 'thread_new', cwd: '/tmp',
  });
  assert.equal(row.inputTokens, 21312, 'a baseline taken at first read would have reported 0 here');
  assert.equal(row.baseline?.inputTokens, 0);
  assert.equal(row.cumulativeAdjusted, true);
});

test('a codex thread novakai ADOPTED is billed from the baseline at first read, labelled', () => {
  const home = providerHome();
  const dir = path.join(home, '.codex', 'sessions', '2026', '07', '28');
  const file = jsonl(dir, 'rollout-a-thread_old.jsonl', [
    { payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 21312, output_tokens: 9 } } } },
  ]);
  const reader = createUsageReader({ home });
  reader.trackSession('sess_adopted', { threadPreexisting: true });
  const session = {
    sessionId: 'sess_adopted', provider: 'codex' as const,
    providerConversationId: 'thread_old', cwd: '/tmp',
  };

  const first = reader.read(session);
  assert.equal(first.inputTokens, 0, 'the pre-existing 21312 is not ours to bill');
  assert.equal(first.baseline?.inputTokens, 21312);

  // The thread advances the way the real one did: 21312 → 45338.
  writeFileSync(file, JSON.stringify({
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 45338, output_tokens: 16 } } },
  }) + '\n');

  const second = reader.read(session);
  assert.equal(second.inputTokens, 45338 - 21312, 'the delta, not the running total');
  assert.equal(second.outputTokens, 16 - 9);
  assert.equal(second.providerTotal?.inputTokens, 45338, 'the raw total stays visible — nothing hidden');
  assert.match(second.note, /baseline/i, 'the adjustment is LABELLED, per the packet');
});

test('claude and kimi are never baseline-adjusted — their records are per-turn', () => {
  const home = providerHome();
  jsonl(path.join(home, '.claude', 'projects', '-tmp-repo'), 'conv_1.jsonl', [
    { timestamp: '2026-07-28T01:00:00.000Z', message: { id: 'm1', usage: { input_tokens: 11, output_tokens: 4 } } },
  ]);
  const reader = createUsageReader({ home });

  const row = reader.read({
    sessionId: 'sess_c', provider: 'claude', providerConversationId: 'conv_1', cwd: '/tmp/repo',
  });
  assert.equal(row.inputTokens, 11);
  assert.equal(row.cumulativeAdjusted, false);
  assert.equal(row.baseline, null);
});

test('a session with no provider conversation id yet reports unavailable, with the reason', () => {
  const reader = createUsageReader({ home: providerHome() });
  const row = reader.read({
    sessionId: 'sess_fresh', provider: 'kimi', providerConversationId: null, cwd: '/tmp',
  });
  assert.equal(row.basis, 'unavailable');
  assert.equal(row.inputTokens, null, 'null, never a guessed zero');
  assert.match(row.note, /no provider conversation id/i);
});

test('a transcript that cannot be found reports unavailable and names what it looked for', () => {
  const reader = createUsageReader({ home: providerHome() });
  const row = reader.read({
    sessionId: 'sess_x', provider: 'codex', providerConversationId: 'thread_ghost', cwd: '/tmp',
  });
  assert.equal(row.basis, 'unavailable');
  assert.equal(row.inputTokens, null);
  assert.match(row.note, /thread_ghost/, 'the gap names the handle it could not resolve');
});

test('the kimi wire.jsonl layout is discovered under any working-dir bucket', () => {
  const home = providerHome();
  jsonl(path.join(home, '.kimi-code', 'sessions', 'wd_9f2', 'session_abc123', 'agents', 'main'),
    'wire.jsonl', [
      { time: 1785225000000, type: 'context.append_loop_event', event: { type: 'step.end', usage: { inputOther: 7, output: 2 } } },
    ]);
  const reader = createUsageReader({ home });

  const row = reader.read({
    sessionId: 'sess_k', provider: 'kimi', providerConversationId: 'abc123', cwd: '/tmp',
  });
  assert.equal(row.basis, 'transcript');
  assert.equal(row.inputTokens, 7);
  assert.equal(row.outputTokens, 2);
});
