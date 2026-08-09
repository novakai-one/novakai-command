// S2b — transcript watchers (TRN-001, DEC-S2-10, §22 rulings 6+8).
// Copy-only custody: new provider transcript content appears under
// .novakai/transcripts/<provider>/ automatically; byte-offset checkpoints
// (R3-14); truncation/rotation → full re-copy into a NEW copy record;
// watch-while-running only. Fixture includes a SUBAGENT transcript file —
// the watcher must copy parent AND subagent files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync, truncateSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTranscriptWatcher, defaultSources } from '../core/watcher.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fixture {
  root: string;        // .novakai/ root (copies + .state live here)
  srcClaude: string;   // fake ~/.claude/projects
  srcKimi: string;     // fake ~/.kimi-code
  parentFile: string;
  subagentFile: string;
}

function makeFixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), 'nvk-trn-'));
  const root = path.join(base, '.novakai');
  const srcClaude = path.join(base, 'home', '.claude', 'projects');
  const srcKimi = path.join(base, 'home', '.kimi-code');
  // claude layout: projects/<proj>/<session>.jsonl + <proj>/<session>/subagents/agent-*.jsonl
  const projDir = path.join(srcClaude, '-Users-chris-app');
  const subDir = path.join(projDir, 'sess_1', 'subagents');
  mkdirSync(subDir, { recursive: true });
  mkdirSync(path.join(srcKimi, 'server', 'events'), { recursive: true });
  const parentFile = path.join(projDir, 'sess_1.jsonl');
  const subagentFile = path.join(subDir, 'agent-abc123.jsonl');
  writeFileSync(parentFile, '{"role":"user","text":"hi"}\n');
  writeFileSync(subagentFile, '{"role":"user","text":"subagent task"}\n');
  writeFileSync(path.join(srcKimi, 'server', 'events', 'session_k1.jsonl'), '{"role":"meta"}\n');
  return { root, srcClaude, srcKimi, parentFile, subagentFile };
}

function watch(f: Fixture, intervalMs = 40) {
  return createTranscriptWatcher({
    root: f.root,
    sources: [
      { provider: 'claude', dir: f.srcClaude },
      { provider: 'kimi', dir: f.srcKimi },
    ],
    intervalMs,
  });
}

test('watcher copies parent AND subagent transcript files (ruling 8)', async () => {
  const f = makeFixture();
  const w = watch(f);
  await w.start();
  await sleep(150);
  await w.stop();
  const claudeCopy = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app', 'sess_1.jsonl');
  const subCopy = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app', 'sess_1', 'subagents', 'agent-abc123.jsonl');
  const kimiCopy = path.join(f.root, 'transcripts', 'kimi', 'server', 'events', 'session_k1.jsonl');
  assert.ok(existsSync(claudeCopy), 'parent copied');
  assert.ok(existsSync(subCopy), 'subagent copied');
  assert.ok(existsSync(kimiCopy), 'kimi file copied');
  assert.equal(readFileSync(claudeCopy, 'utf8'), '{"role":"user","text":"hi"}\n');
  assert.equal(readFileSync(subCopy, 'utf8'), '{"role":"user","text":"subagent task"}\n');
});

// 2026-08-09 churn fix: the scan's content reads are metered through the
// readRange seam. Output-based tests cannot catch this regression — the old
// whole-file-every-tick code produced byte-identical copies while allocating
// GB/s at real transcript volume (the Aug 3/8 "ingester leak").
test('steady-state reads ZERO content bytes; growth reads at most tail window + delta', async () => {
  const f = makeFixture();
  let bytesRead = 0;
  const countingRead = (filePath: string, from: number, length: number): Buffer => {
    bytesRead += Math.max(0, length);
    return readFileSync(filePath).subarray(from, from + length);
  };
  const watchOnce = async () => {
    // start() runs one immediate scan; the huge interval means no timer ticks.
    const w = createTranscriptWatcher({
      root: f.root,
      sources: [
        { provider: 'claude', dir: f.srcClaude },
        { provider: 'kimi', dir: f.srcKimi },
      ],
      intervalMs: 3_600_000,
      readRange: countingRead,
    });
    await w.start();
    await w.stop();
  };

  await watchOnce(); // first sight: full copies, reads are legitimate here

  bytesRead = 0;
  await watchOnce(); // nothing changed anywhere
  assert.equal(bytesRead, 0, 'unchanged checkpointed files must read zero content bytes');

  const delta = '{"role":"assistant","text":"reply"}\n';
  appendFileSync(f.parentFile, delta);
  bytesRead = 0;
  await watchOnce(); // one grown file: tail window (≤64) + delta, nothing else
  assert.ok(
    bytesRead <= 64 + delta.length,
    `growth read ${bytesRead} bytes — must be at most 64 (tail window) + ${delta.length} (delta)`,
  );
  const copy = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app', 'sess_1.jsonl');
  assert.equal(
    readFileSync(copy, 'utf8'),
    '{"role":"user","text":"hi"}\n' + delta,
    'ranged reads still produce a byte-faithful copy',
  );
});

test('appended content is copied incrementally (byte-offset checkpoint)', async () => {
  const f = makeFixture();
  const w = watch(f);
  await w.start();
  await sleep(120);
  appendFileSync(f.parentFile, '{"role":"assistant","text":"reply"}\n');
  await sleep(150);
  await w.stop();
  const copy = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app', 'sess_1.jsonl');
  assert.equal(readFileSync(copy, 'utf8'), '{"role":"user","text":"hi"}\n{"role":"assistant","text":"reply"}\n');
});

test('checkpoint resume: restart produces NO duplicates', async () => {
  const f = makeFixture();
  const w1 = watch(f);
  await w1.start();
  await sleep(120);
  await w1.stop();
  appendFileSync(f.parentFile, '{"role":"assistant","text":"between runs"}\n');
  const w2 = watch(f);
  await w2.start();
  await sleep(150);
  await w2.stop();
  const copy = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app', 'sess_1.jsonl');
  assert.equal(
    readFileSync(copy, 'utf8'),
    '{"role":"user","text":"hi"}\n{"role":"assistant","text":"between runs"}\n',
    'no duplicate lines after restart',
  );
});

test('truncation → full re-copy into a NEW copy record; the original copy is immutable', async () => {
  const f = makeFixture();
  const w1 = watch(f);
  await w1.start();
  await sleep(120);
  await w1.stop();
  const copy = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app', 'sess_1.jsonl');
  const original = readFileSync(copy, 'utf8');
  truncateSync(f.parentFile, 0);
  writeFileSync(f.parentFile, '{"role":"user","text":"fresh session"}\n');
  const w2 = watch(f);
  await w2.start();
  await sleep(150);
  await w2.stop();
  assert.equal(readFileSync(copy, 'utf8'), original, 'original copy never mutated (ruling 6)');
  const dir = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app');
  const rescans = readdirSync(dir).filter((n) => n.startsWith('sess_1.rescan-'));
  assert.equal(rescans.length, 1, 'one rescan copy record');
  assert.equal(readFileSync(path.join(dir, rescans[0]), 'utf8'), '{"role":"user","text":"fresh session"}\n');
});

test('status exposes watched files and copied bytes; app-closed = no watching, no error', async () => {
  const f = makeFixture();
  const w = watch(f);
  assert.deepEqual(w.status(), { running: false, files: 0, bytesCopied: 0, lastScanAt: null, skips: [] });
  await w.start();
  await sleep(120);
  const st = w.status();
  assert.equal(st.running, true);
  assert.equal(st.files, 3);
  assert.ok(st.bytesCopied > 0);
  assert.ok(typeof st.lastScanAt === 'string');
  await w.stop();
  assert.equal(w.status().running, false);
});

test('M12 tail-hash regrow: bytes BEFORE the cursor rewritten while the file grows → full re-scan into a NEW copy record', async () => {
  const f = makeFixture();
  const w1 = watch(f);
  await w1.start();
  await sleep(120);
  await w1.stop();
  const copy = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app', 'sess_1.jsonl');
  const original = readFileSync(copy, 'utf8');
  // Same inode, LARGER size, but the bytes before the old offset differ
  // (provider rewrote history, then appended) — the tail hash at the cursor
  // no longer matches → the copy must NOT be appended to blindly.
  writeFileSync(f.parentFile, '{"role":"user","text":"REWRITTEN"}\n{"role":"assistant","text":"new"}\n');
  const w2 = watch(f);
  await w2.start();
  await sleep(150);
  await w2.stop();
  assert.equal(readFileSync(copy, 'utf8'), original, 'original copy immutable');
  const dir = path.join(f.root, 'transcripts', 'claude', '-Users-chris-app');
  const rescans = readdirSync(dir).filter((n) => n.startsWith('sess_1.rescan-'));
  assert.equal(rescans.length, 1, 'regrow past a rewritten cursor produced a rescan record');
  assert.equal(readFileSync(path.join(dir, rescans[0]), 'utf8'), '{"role":"user","text":"REWRITTEN"}\n{"role":"assistant","text":"new"}\n');
});

test('M6: an unreadable source file is a typed skip — the scan NEVER throws out of the interval', async () => {
  const f = makeFixture();
  chmodSync(f.subagentFile, 0o000); // stat works, read fails (EACCES)
  const w = watch(f);
  await w.start();
  await sleep(150);
  await w.stop();
  chmodSync(f.subagentFile, 0o644); // restore so tmp cleanup works
  const st = w.status();
  assert.equal(st.running, false);
  assert.ok(st.skips.length >= 1, 'the skip was recorded, not swallowed');
  assert.equal(st.skips[0].src, f.subagentFile);
  assert.ok(st.skips[0].reason.length > 0);
  // the OTHER files still copied — one bad file never stalls the scan
  assert.ok(existsSync(path.join(f.root, 'transcripts', 'claude', '-Users-chris-app', 'sess_1.jsonl')));
  assert.ok(existsSync(path.join(f.root, 'transcripts', 'kimi', 'server', 'events', 'session_k1.jsonl')));
});

test('defaultSources discovers real provider dirs, existing dirs only', () => {
  const sources = defaultSources();
  for (const s of sources) {
    assert.ok(['kimi', 'claude', 'codex'].includes(s.provider));
    assert.ok(existsSync(s.dir), `${s.provider} dir must exist: ${s.dir}`);
  }
});
