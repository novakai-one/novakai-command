import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStoreDir, auditDir, appendLine, checksumStores,
  StoreValidationError, StoreRefusalError, acquireLock, releaseLock,
} from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KNOWN_VALID = path.join(HERE, 'fixtures', 'known-valid');
const TS = '2026-07-21T13:00:00+10:00';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function freshDir(seedDrift = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nvk-store-test-'));
  cpSync(KNOWN_VALID, dir, { recursive: true });
  if (seedDrift) {
    // duplicated id pair + a missing-ts record, raw-written like a bypassing agent would
    const dup = JSON.stringify({ id: 'log_2026-07-21-777', kind: 'log', ts: TS, body: 'dup a' }) + '\n'
      + JSON.stringify({ id: 'log_2026-07-21-777', kind: 'log', ts: TS, body: 'dup b' }) + '\n'
      + JSON.stringify({ id: 'log_2026-07-21-778', kind: 'log', body: 'no ts drift' }) + '\n';
    writeFileSync(path.join(dir, 'captains-log.jsonl'), readFileSync(path.join(dir, 'captains-log.jsonl'), 'utf8') + dup);
  }
  return dir;
}

function fileBytes(dir) {
  const result = {};
  for (const name of Object.keys(checksumStores(dir))) {
    result[name] = readFileSync(path.join(dir, name));
  }
  return result;
}

function assertUnchanged(before, dir) {
  const after = fileBytes(dir);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const [name, buffer] of Object.entries(after)) {
    assert.ok(buffer.equals(before[name]), `${name} mutated by a rejected/refused operation`);
  }
}

// --- read + audit + checksums ------------------------------------------------

{
  const dir = freshDir();
  const snapshot = readStoreDir(dir);
  assert.equal(Object.keys(snapshot.files).length, 9); // 10 kinds across 9 files (okrs holds objective + kr)
  const { audit, checksums } = auditDir(dir);
  assert.deepEqual(audit.findings, []);
  assert.deepEqual(checksums, checksumStores(dir));
  rmSync(dir, { recursive: true, force: true });
}
{
  // SC4: a file changing between the bracketing hashes discards the snapshot
  const dir = freshDir();
  assert.throws(
    () => auditDir(dir, {
      attempts: 2,
      betweenReads: () => {
        writeFileSync(path.join(dir, 'captains-log.jsonl'),
          readFileSync(path.join(dir, 'captains-log.jsonl'), 'utf8')
          + JSON.stringify({ id: 'log_2026-07-21-950', kind: 'log', ts: TS, body: 'mid-read write' }) + '\n');
      },
    }),
    /SC4/,
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- appendLine: byte-identical valid appends --------------------------------

{
  const dir = freshDir();
  const before = fileBytes(dir);
  // deliberately whitespace-bearing lexical JSON — stored bytes must be identical
  const raw = '{"id": "task_ws-probe",  "kind": "task",\t"ts": "2026-07-21T13:00:00+10:00", "title": "W"}';
  const result = appendLine(dir, 'tasks.jsonl', raw);
  assert.equal(result.id, 'task_ws-probe');
  const after = readFileSync(path.join(dir, 'tasks.jsonl'));
  assert.ok(after.equals(Buffer.concat([before['tasks.jsonl'], Buffer.from(raw + '\n')])),
    'append must be exactly oldBytes + rawLine + newline');
  // all other files untouched
  for (const [name, buffer] of Object.entries(fileBytes(dir))) {
    if (name !== 'tasks.jsonl') assert.ok(buffer.equals(before[name]));
  }
  // lock released after append
  assert.ok(!existsSync(path.join(dir, '.nvk-store.lock')));
  rmSync(dir, { recursive: true, force: true });
}
{
  // every valid kind + tombstone appends byte-identical (C2)
  const dir = freshDir();
  const candidates = [
    ['decisions.jsonl', { id: 'DEC-2026-07-21-201', kind: 'decision', ts: TS, title: 'D', body: 'B' }],
    ['requests.jsonl', { id: 'request_c2', kind: 'request', ts: TS, question: 'Q?', options: ['a'], status: 'pending' }],
    ['missions.jsonl', { id: 'mission_c2', kind: 'mission', ts: TS, title: 'M', owner: 'chief-kimi' }],
    ['tasks.jsonl', { id: 'task_c2', kind: 'task', ts: TS, title: 'T', status: 'todo' }],
    ['captains-log.jsonl', { id: 'log_2026-07-21-901', kind: 'log', ts: TS, body: 'observed' }],
    ['learnings.jsonl', { id: 'learning_c2', kind: 'learning', ts: TS, body: 'L', evidence: [{ kind: 'log', value: 'log_2026-07-21-901' }] }],
    ['okrs.jsonl', { id: 'okr_c2', kind: 'objective', ts: TS, title: 'O', horizon: 'next' }],
    ['okrs.jsonl', { id: 'kr_c2_1', kind: 'kr', ts: TS, objective: 'okr_c2', body: 'K' }],
    ['projects.jsonl', { id: 'proj_c2', kind: 'project', ts: TS, title: 'P', status: 'active', path: '/tmp/p' }],
    ['issues.jsonl', { id: 'issue_c2', kind: 'issue', ts: TS, title: 'I' }],
    ['tasks.jsonl', { id: 'task_c2-tomb', kind: 'task', ts: TS, status: 'refiled', refiledTo: 'mission_c2', updated: TS }],
  ];
  for (const [storeFile, block] of candidates) {
    const raw = JSON.stringify(block);
    const beforeBytes = readFileSync(path.join(dir, storeFile));
    appendLine(dir, storeFile, raw);
    const afterBytes = readFileSync(path.join(dir, storeFile));
    assert.ok(afterBytes.equals(Buffer.concat([beforeBytes, Buffer.from(raw + '\n')])), `${block.id} byte-identical`);
  }
  rmSync(dir, { recursive: true, force: true });
}
{
  // M1: clean append succeeds into a dir seeded with historical drift
  const dir = freshDir(true);
  const raw = JSON.stringify({ id: 'issue_isolated-clean', kind: 'issue', ts: TS, title: 'clean' });
  appendLine(dir, 'issues.jsonl', raw);
  // ...but colliding with the duplicated id or ref'ing it still blocks
  assert.throws(
    () => appendLine(dir, 'captains-log.jsonl', JSON.stringify({ id: 'log_2026-07-21-777', kind: 'log', ts: TS, body: 'x' })),
    (error) => error instanceof StoreValidationError && error.violations.some((violation) => violation.code === 'DUP-ID'),
  );
  assert.throws(
    () => appendLine(dir, 'issues.jsonl', JSON.stringify({ id: 'issue_ambig-ref', kind: 'issue', ts: TS, refs: [{ kind: 'log', value: 'log_2026-07-21-777' }] })),
    (error) => error instanceof StoreValidationError && error.violations.some((violation) => violation.code === 'REF-AMBIGUOUS'),
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- appendLine: every violation class rejects at the seam, bytes unchanged (C1/M3) --

{
  const dir = freshDir(true);
  const before = fileBytes(dir);
  const rejectionCases = [
    ['PARSE', 'tasks.jsonl', '{broken json'],
    ['LINE-BOUNDARY', 'tasks.jsonl', JSON.stringify({ id: 'task_r1', kind: 'task', ts: TS, title: 'a' }) + '\n' + JSON.stringify({ id: 'task_r2', kind: 'task', ts: TS, title: 'b' })],
    ['CORE-MISSING', 'tasks.jsonl', JSON.stringify({ id: 'task_r3', kind: 'task', title: 'no ts', created: TS })],
    ['ID-FORMAT', 'tasks.jsonl', JSON.stringify({ id: 'task_', kind: 'task', ts: TS, title: 'bad id' })],
    ['WRONG-STORE', 'missions.jsonl', JSON.stringify({ id: 'task_r4', kind: 'task', ts: TS, title: 'wrong home' })],
    ['STATUS-UNKNOWN', 'tasks.jsonl', JSON.stringify({ id: 'task_r5', kind: 'task', ts: TS, title: 'T', status: 'zombie' })],  // doing joined the set (mission_mission-object-model)
    ['FIELD-MISSING', 'missions.jsonl', JSON.stringify({ id: 'mission_r6', kind: 'mission', ts: TS, owner: 'x' })],
    ['FIELD-INVALID', 'okrs.jsonl', JSON.stringify({ id: 'okr_r7', kind: 'objective', ts: TS, title: 'O', horizon: 'someday' })],
    ['REF-SHAPE', 'tasks.jsonl', JSON.stringify({ id: 'task_r8', kind: 'task', ts: TS, title: 'T', refs: [{ kind: 'wombat', value: 'x' }] })],
    ['REF-DANGLING', 'tasks.jsonl', JSON.stringify({ id: 'task_r9', kind: 'task', ts: TS, title: 'T', refs: [{ kind: 'mission', value: 'mission_ghost' }] })],
    ['REF-WRONG-KIND', 'tasks.jsonl', JSON.stringify({ id: 'task_r10', kind: 'task', ts: TS, title: 'T', refs: [{ kind: 'task', value: 'mission_fixture-prime' }] })],
    ['REF-AMBIGUOUS', 'tasks.jsonl', JSON.stringify({ id: 'task_r11', kind: 'task', ts: TS, title: 'T', refs: [{ kind: 'log', value: 'log_2026-07-21-777' }] })],
    ['DUP-ID', 'tasks.jsonl', JSON.stringify({ id: 'task_fixture-alpha', kind: 'task', ts: TS, title: 'T' })],
    ['RELATION-MISSING', 'learnings.jsonl', JSON.stringify({ id: 'learning_r12', kind: 'learning', ts: TS, body: 'no evidence' })],
    ['KR-SHAPE', 'okrs.jsonl', JSON.stringify({ id: 'okr_r13', kind: 'objective', ts: TS, title: 'O', horizon: 'now', krs: [{ kind: 'kr', id: 'kr_r13_1' }] })],
  ];
  for (const [code, storeFile, raw] of rejectionCases) {
    assert.throws(
      () => appendLine(dir, storeFile, raw),
      (error) => error instanceof StoreValidationError
        && error.violations.some((violation) => violation.code === code)
        && /[a-z]/.test(error.message),
      `expected ${code} rejection with a clear reason`,
    );
  }
  assertUnchanged(before, dir);
  rmSync(dir, { recursive: true, force: true });
}

// --- M7 filesystem refusals --------------------------------------------------

{
  const dir = freshDir();
  const before = fileBytes(dir);
  const goodLine = JSON.stringify({ id: 'task_m7', kind: 'task', ts: TS, title: 'T' });
  const refused = (fn) => assert.throws(fn, (error) => error instanceof StoreRefusalError);
  refused(() => appendLine(dir, 'nope.jsonl', goodLine));                      // unknown store name
  refused(() => appendLine(dir, '../tasks.jsonl', goodLine));                  // traversal
  refused(() => appendLine(dir, '/etc/passwd', goodLine));                     // absolute
  rmSync(path.join(dir, 'issues.jsonl'));
  refused(() => appendLine(dir, 'issues.jsonl', JSON.stringify({ id: 'issue_m7', kind: 'issue', ts: TS }))); // missing file — never create
  assert.ok(!existsSync(path.join(dir, 'issues.jsonl')), 'appendLine must not create store files');
  mkdirSync(path.join(dir, 'issues.jsonl'));
  refused(() => appendLine(dir, 'issues.jsonl', JSON.stringify({ id: 'issue_m7', kind: 'issue', ts: TS }))); // directory
  rmSync(path.join(dir, 'issues.jsonl'), { recursive: true });
  const outside = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-outside-')), 'issues.jsonl');
  writeFileSync(outside, '');
  symlinkSync(outside, path.join(dir, 'issues.jsonl'));
  refused(() => appendLine(dir, 'issues.jsonl', JSON.stringify({ id: 'issue_m7', kind: 'issue', ts: TS }))); // symlink
  rmSync(path.join(dir, 'issues.jsonl'));
  writeFileSync(path.join(dir, 'issues.jsonl'), '{"id":"issue_fixture-one","kind":"issue","ts":"2026-07-21T12:00:00+10:00","title":"Fixture issue","status":"open","severity":"minor"}'); // no trailing newline
  refused(() => appendLine(dir, 'issues.jsonl', JSON.stringify({ id: 'issue_m7b', kind: 'issue', ts: TS }))); // unterminated final line
  for (const name of ['tasks.jsonl', 'missions.jsonl']) {
    assert.ok(readFileSync(path.join(dir, name)).equals(before[name]));
  }
  rmSync(dir, { recursive: true, force: true });
}

// --- Delta-S2 lock protocol --------------------------------------------------

{
  // slow-but-alive holder is NOT broken: lock owned by THIS live process
  const dir = freshDir();
  const before = fileBytes(dir);
  const lock = acquireLock(dir);
  assert.throws(
    () => appendLine(dir, 'tasks.jsonl', JSON.stringify({ id: 'task_lock1', kind: 'task', ts: TS, title: 'T' }), { lockTimeoutMs: 300 }),
    /lock/i,
  );
  assertUnchanged(before, dir);
  releaseLock(lock);
  rmSync(dir, { recursive: true, force: true });
}
{
  // dead-holder lock is taken over — append succeeds
  const dir = freshDir();
  const deadPid = spawnSync('node', ['-e', 'process.exit(0)']).pid;
  mkdirSync(path.join(dir, '.nvk-store.lock'));
  writeFileSync(path.join(dir, '.nvk-store.lock', 'owner.json'), JSON.stringify({ pid: deadPid, token: 'dead-token' }) + '\n');
  appendLine(dir, 'tasks.jsonl', JSON.stringify({ id: 'task_lock2', kind: 'task', ts: TS, title: 'T' }), { lockTimeoutMs: 2000 });
  assert.ok(!existsSync(path.join(dir, '.nvk-store.lock')), 'takeover lock released after append');
  rmSync(dir, { recursive: true, force: true });
}
{
  // release with a stale token is a no-op — a writer can never delete a successor's lock
  const dir = freshDir();
  const lock = acquireLock(dir);
  releaseLock({ lockDir: lock.lockDir, token: 'not-the-token' });
  assert.ok(existsSync(lock.lockDir), 'stale-token release must not remove the lock');
  releaseLock(lock);
  assert.ok(!existsSync(lock.lockDir));
  rmSync(dir, { recursive: true, force: true });
}

// --- baseline id enrollment (delta moderate) ---------------------------------

{
  const dir = freshDir();
  const baselinePath = path.join(dir, 'stores-baseline.json');
  writeFileSync(baselinePath, JSON.stringify({ version: 1, fingerprints: [], ids: ['task_fixture-alpha'] }) + '\n');
  appendLine(dir, 'tasks.jsonl', JSON.stringify({ id: 'task_enrolled', kind: 'task', ts: TS, title: 'T' }), { baselinePath });
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  assert.ok(baseline.ids.includes('task_enrolled'), 'newly accepted id enrolled in inventory');
  assert.ok(baseline.ids.includes('task_fixture-alpha'), 'existing inventory preserved');
  rmSync(dir, { recursive: true, force: true });
}

// --- foreign-engine files are invisible (2026-08-09 churn fix) ---------------
// .novakai/stores is shared with the packages/foundation store-engine, whose
// telemetry files (traces.jsonl, commandReceipts.jsonl, ...) are not ours and
// grow without bound. Globbing them made every read/write O(entire dir) — the
// Aug 3/8/9 incidents. They must be excluded from reads, checksums, AND never
// poison audits even when their content is invalid JSONL.

{
  const dir = freshDir();
  writeFileSync(path.join(dir, 'traces.jsonl'), 'not json at all\n{"half":\n');
  writeFileSync(path.join(dir, 'commandReceipts.jsonl'), '{"kind":"receipt","id":"receipt_x"}\n');
  const snapshot = readStoreDir(dir);
  assert.ok(!('traces.jsonl' in snapshot.files), 'foreign traces.jsonl excluded from readStoreDir');
  assert.ok(!('commandReceipts.jsonl' in snapshot.files), 'foreign commandReceipts.jsonl excluded from readStoreDir');
  assert.equal(Object.keys(snapshot.files).length, 9, 'snapshot still covers exactly the schema-recognized files');
  const checksums = checksumStores(dir);
  assert.ok(!('traces.jsonl' in checksums), 'foreign file excluded from checksums');
  assert.ok(!('commandReceipts.jsonl' in checksums), 'foreign file excluded from checksums');
  const { audit } = auditDir(dir);
  assert.deepEqual(audit.findings, [], 'invalid foreign content cannot poison the audit');
  // the write path ignores foreign files too: a normal append still validates + lands
  appendLine(dir, 'captains-log.jsonl', JSON.stringify({ id: 'log_2026-08-09-900', kind: 'log', ts: TS, body: 'append with foreign files present' }));
  rmSync(dir, { recursive: true, force: true });
}

console.log('store shell tests passed');
