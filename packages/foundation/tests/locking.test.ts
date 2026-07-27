// M1/M2 — lock-hold hygiene (adversarial audit).
// M1: resolveQuarantine must perform the reconcile-trace + tombstone +
// lifecycle-trace mutation pair inside ONE lock hold (today the tombstone
// line is written with NO lock at all).
// M2: boot reconciliation (torn-line truncate + stamping) must run under the
// global mutation lock; a live lock holder must make boot wait/fail typed,
// never truncate underneath an active writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle, createObject, resolveQuarantine, mintClientOpId, type ObjectId,
} from '../contract/index.js';
import { StoreEngine } from '../core/store-engine/engine.js';
import { acquireLock, releaseLock } from '../core/store-engine/lock.js';

const freshRoot = () => mkdtempSync(path.join(tmpdir(), 'nvk-fnd-lock-'));

function plantTombstone(root: string, refId: string): void {
  const line = JSON.stringify({
    envelope: {
      kind: 'quarantine', id: `quarantine_${refId}`, schemaVersion: 1,
      createdAt: new Date().toISOString(), permissionLevel: 'private', createdBy: 'sys_reconciler',
    },
    payload: { quarantinedRef: { kind: 'settings', id: refId }, reason: 'corrupt_record', status: 'open' },
    meta: { opId: `srv_tomb-${refId}`, clientOpId: `op_tomb-${refId}`, version: 1 },
  });
  mkdirSync(root, { recursive: true });
  appendFileSync(path.join(root, 'quarantine.jsonl'), line + '\n');
}

test('M1: resolveQuarantine writes NOTHING when the mutation lock is held by a live process', async () => {
  const root = freshRoot();
  const lock = { current: null as null | ReturnType<typeof acquireLock> };
  try {
    plantTombstone(root, 'settings_q');
    const h = composeHandle({
      root, capability: 'foundation', allowedKinds: ['settings', 'quarantine'],
      principal: 'person_chris', lockTimeoutMs: 150,
    });
    // boot BEFORE taking the lock (M2: boot itself is lock-guarded)
    await createObject(h, {
      kind: 'settings', id: 'settings_boot', schemaVersion: 1, createdAt: new Date().toISOString(),
      permissionLevel: 'private', createdBy: 'person_chris', key: 'k', value: 1,
    }, mintClientOpId());
    lock.current = acquireLock(root);
    const res = await resolveQuarantine(h, 'quarantine_settings_q' as ObjectId, 'dismiss', mintClientOpId());
    assert.equal(res.ok, false, 'resolveQuarantine must not write outside the lock');
    if (!res.ok) assert.equal(res.error.code, 'LockBusy');
    // no tombstone status line was appended behind the holder's back
    const lines = readFileSync(path.join(root, 'quarantine.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'only the planted open tombstone may exist');
  } finally {
    if (lock.current) releaseLock(lock.current);
    rmSync(root, { recursive: true, force: true });
  }
});

test('M1: resolveQuarantine(dismiss) commits under normal conditions (lock free)', async () => {
  const root = freshRoot();
  try {
    plantTombstone(root, 'settings_q2');
    const h = composeHandle({ root, capability: 'foundation', allowedKinds: ['settings', 'quarantine'], principal: 'person_chris' });
    const res = await resolveQuarantine(h, 'quarantine_settings_q2' as ObjectId, 'dismiss', mintClientOpId());
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.status, 'dismissed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M2: boot reconciliation runs UNDER the lock — a live holder blocks the torn-line truncate', async () => {
  const root = freshRoot();
  mkdirSync(root, { recursive: true });
  // plant a valid line + a torn tail
  const h = composeHandle({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
  await createObject(h, {
    kind: 'settings', id: 'settings_good', schemaVersion: 1, createdAt: new Date().toISOString(),
    permissionLevel: 'private', createdBy: 'person_chris', key: 'k', value: 1,
  }, mintClientOpId());
  appendFileSync(path.join(root, 'settings.jsonl'), '{"envelope":{"kind":"settings","id":"set');
  const before = readFileSync(path.join(root, 'settings.jsonl'), 'utf8');

  const lock = acquireLock(root);
  try {
    const engine = new StoreEngine({ root, lockTimeoutMs: 150 });
    engine.boot();
    const bootFailure = engine.bootError();
    assert.ok(bootFailure, 'boot must not reconcile underneath a live lock holder');
    assert.equal(bootFailure.code, 'LockBusy', 'boot surfaces a typed LockBusy, never a raw throw');
    // torn bytes untouched while the holder is live
    assert.equal(readFileSync(path.join(root, 'settings.jsonl'), 'utf8'), before);
  } finally {
    releaseLock(lock);
    // after release, boot reconciles normally
    const engine = new StoreEngine({ root });
    engine.boot();
    const after = readFileSync(path.join(root, 'settings.jsonl'), 'utf8');
    assert.ok(after.endsWith('\n'));
    assert.ok(after.includes('settings_good'));
    assert.ok(!after.includes('"id":"set\n'));
    rmSync(root, { recursive: true, force: true });
  }
});
