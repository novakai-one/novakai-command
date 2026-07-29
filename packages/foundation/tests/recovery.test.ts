// Crash recovery, quarantine (R3-4), torn-line truncate (R3-3),
// dual-read shim (R3-21), lazy schema upgrade (FND-008/DEC-F10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle, createObject, getObject, listObjects, resolveQuarantine,
  listQuarantineBound, queryTraceBound, mintClientOpId, isAbsent,
  type ObjectId,
} from '../contract/index.js';
import { composeEngine } from '../contract/compose.js'; // M11: internal import
import { StoreEngine } from '../core/store-engine/engine.js';

const freshRoot = () => mkdtempSync(path.join(tmpdir(), 'nvk-fnd-'));

const settingsPayload = (id: string) => ({
  kind: 'settings', id, schemaVersion: 1, createdAt: new Date().toISOString(),
  permissionLevel: 'private', createdBy: 'person_chris', key: id, value: 1,
});

/** Simulate a kill -9 between object append and trace append: write the object
 * line with NO trace, in a fresh root, then boot a NEW engine (new "process"). */
function plantOrphan(root: string, id: string): void {
  const line = JSON.stringify({
    envelope: {
      kind: 'settings', id, schemaVersion: 1,
      createdAt: new Date().toISOString(), permissionLevel: 'private', createdBy: 'person_chris',
    },
    payload: { key: id, value: 1 },
    meta: { opId: `srv_orphan-${id}`, clientOpId: `op_orphan-${id}`, version: 1 },
  });
  mkdirSync(root, { recursive: true });
  appendFileSync(path.join(root, 'settings.jsonl'), line + '\n');
}

/** Plant an open quarantine tombstone directly (corrupt-record ruling path):
 * tombstones apply ONLY to corrupt/unparseable records and trace-orphans —
 * never to objects with a missing trace (S2 ruling). */
function plantTombstone(root: string, refId: string): void {
  const line = JSON.stringify({
    envelope: {
      kind: 'quarantine', id: `quarantine_${refId}`, schemaVersion: 1,
      createdAt: new Date().toISOString(), permissionLevel: 'private', createdBy: 'sys_reconciler',
    },
    payload: {
      quarantinedRef: { kind: 'settings', id: refId }, reason: 'corrupt_record', status: 'open',
    },
    meta: { opId: `srv_tomb-${refId}`, clientOpId: `op_tomb-${refId}`, version: 1 },
  });
  mkdirSync(root, { recursive: true });
  appendFileSync(path.join(root, 'quarantine.jsonl'), line + '\n');
}

function plantLifecycleTraceOrphan(
  root: string,
  action: 'quarantine' | 'resolveQuarantine',
  id: string,
  seq: number,
): void {
  const line = JSON.stringify({
    kind: 'trace',
    id: `trace_${action}_${id}`,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: 'team',
    createdBy: 'sys_reconciler',
    seq,
    opId: `srv_${action}_${id}`,
    clientOpId: `op_${action}_${id}`,
    action,
    target: { kind: 'settings', id },
  });
  mkdirSync(root, { recursive: true });
  appendFileSync(path.join(root, 'traces.jsonl'), `${line}\n`);
}

test('boot reconciliation catches lifecycle trace orphans outside transcript scope', async () => {
  const root = freshRoot();
  try {
    plantLifecycleTraceOrphan(
      root,
      'quarantine',
      'settings_quarantine_trace_orphan',
      0,
    );
    plantLifecycleTraceOrphan(
      root,
      'resolveQuarantine',
      'settings_resolve_trace_orphan',
      1,
    );

    const engine = new StoreEngine({ root });
    engine.boot();
    const quarantine = await listQuarantineBound(engine);
    assert.deepEqual(
      quarantine.items
        .filter((item) => item.reason === 'orphan_trace_no_object')
        .map((item) => item.quarantinedRef.id)
        .sort(),
      [
        'settings_quarantine_trace_orphan',
        'settings_resolve_trace_orphan',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('crash recovery (S2 ruling): kill between object and trace append → object readable with incomplete:true, NEVER tombstoned', async () => {
  const root = freshRoot();
  try {
    plantOrphan(root, 'settings_orphan');
    // new "process": fresh engine instance boots and reconciles
    const engine = new StoreEngine({ root });
    engine.boot();
    // NO tombstone for a missing trace (tombstones = corrupt records / trace-orphans only)
    const quarantine = await listQuarantineBound(engine);
    assert.equal(quarantine.items.some((t) => t.quarantinedRef.id === 'settings_orphan'), false);
    // readable with the incomplete flag, not hidden
    const h = composeHandle({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'person_chris' });
    const got = await getObject(h, 'settings', 'settings_orphan' as ObjectId);
    assert.equal(got.ok, true);
    if (got.ok && !isAbsent(got.value)) assert.equal(got.value.incomplete, true);
    else assert.fail('orphan object must be readable, never hidden');
    // original line NEVER moved or rewritten (R3-4)
    const raw = readFileSync(path.join(root, 'settings.jsonl'), 'utf8');
    assert.ok(raw.includes('settings_orphan'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('crash recovery (S2 ruling): retry with same clientOpId reconciles — trace completed, flag cleared, no double-apply', async () => {
  const root = freshRoot();
  try {
    plantOrphan(root, 'settings_retry');
    new StoreEngine({ root }).boot(); // new "process"
    const h = composeHandle({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'person_chris' });
    // retry the original op after the restart: same payload, same clientOpId
    const retry = await createObject(h, settingsPayload('settings_retry'), 'op_orphan-settings_retry' as ReturnType<typeof mintClientOpId>);
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.value.incomplete, false, 'reconciled object must have the flag cleared');
    // no double-apply: exactly one object line for the id
    const lines = readFileSync(path.join(root, 'settings.jsonl'), 'utf8')
      .split('\n').filter((l) => l.includes('"id":"settings_retry"'));
    assert.equal(lines.length, 1);
    // trace now exists for the original opId
    const traces = queryTraceBound(composeEngine({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'person_chris' }), { opId: 'srv_orphan-settings_retry' as never });
    assert.equal((await traces).items.length, 1);
    // getObject agrees: readable, complete
    const got = await getObject(h, 'settings', 'settings_retry' as ObjectId);
    assert.equal(got.ok, true);
    if (got.ok && !isAbsent(got.value)) assert.equal(got.value.incomplete, false);
    else assert.fail('reconciled object must be readable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('quarantine: readers skip quarantined ids; writers get Quarantined; resolveQuarantine(reconcile) re-stamps the trace', async () => {
  const root = freshRoot();
  try {
    plantOrphan(root, 'settings_orphan');
    plantTombstone(root, 'settings_orphan'); // corrupt-record tombstone (the only kind that hides an object)
    const engine = new StoreEngine({ root });
    engine.boot();
    const h = composeHandle({ root, capability: 'foundation', allowedKinds: ['settings', 'quarantine'], principal: 'person_chris' });
    // engine cached by composeHandle already booted once — boot is idempotent;
    // the fresh engine above created the tombstone. Re-read via cached engine:
    const quarantine = await listQuarantineBound(composeEngine({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'person_chris' }));
    const tombstone = quarantine.items.find((t) => t.quarantinedRef.id === 'settings_orphan');
    assert.ok(tombstone);
    // readers skip (Absent — quarantine surfaces, never crashes)
    const got = await getObject(h, 'settings', 'settings_orphan' as ObjectId);
    assert.equal(got.ok, true);
    if (got.ok) assert.ok(isAbsent(got.value));
    const listed = await listObjects(h, 'settings');
    assert.equal(listed.ok, true);
    if (listed.ok) assert.equal(listed.value.items.length, 0);
    // writers rejected (§11 ruling 5)
    const write = await createObject(h, settingsPayload('settings_orphan'), mintClientOpId());
    assert.equal(write.ok, false);
    if (!write.ok) assert.equal(write.error.code, 'Quarantined');
    // human resolution path (R3-11): reconcile re-stamps the trace
    const resolved = await resolveQuarantine(h, tombstone.id as ObjectId, 'reconcile', mintClientOpId());
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.value.status, 'resolved');
      assert.equal(resolved.value.resolution, 'reconcile');
      assert.equal(resolved.value.resolvedBy, 'person_chris');
    }
    // object readable again, incomplete cleared
    const after = await getObject(h, 'settings', 'settings_orphan' as ObjectId);
    assert.equal(after.ok, true);
    if (after.ok && !isAbsent(after.value)) assert.equal(after.value.incomplete, false);
    else assert.fail('resolved object must be readable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('quarantine: resolveQuarantine(dismiss) → status dismissed (human path)', async () => {
  const root = freshRoot();
  try {
    plantOrphan(root, 'settings_orphan2');
    plantTombstone(root, 'settings_orphan2');
    new StoreEngine({ root }).boot();
    const engine = composeEngine({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'person_chris' });
    const quarantine = await listQuarantineBound(engine);
    const tombstone = quarantine.items.find((t) => t.quarantinedRef.id === 'settings_orphan2');
    assert.ok(tombstone);
    const h = composeHandle({ root, capability: 'foundation', allowedKinds: ['quarantine'], principal: 'person_chris' });
    const res = await resolveQuarantine(h, tombstone.id as ObjectId, 'dismiss', mintClientOpId());
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.status, 'dismissed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R3-3: torn final line → truncate-on-open + traced truncate event', async () => {
  const root = freshRoot();
  try {
    const h = composeHandle({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
    await createObject(h, settingsPayload('settings_good'), mintClientOpId());
    // simulate a torn write (kill mid-append)
    appendFileSync(path.join(root, 'settings.jsonl'), '{"envelope":{"kind":"settings","id":"set');
    // new process boots
    const engine = new StoreEngine({ root });
    engine.boot();
    // torn bytes removed, good line intact
    const raw = readFileSync(path.join(root, 'settings.jsonl'), 'utf8');
    assert.ok(!raw.includes('"id":"set\n'));
    assert.ok(raw.includes('settings_good'));
    // truncate traced
    const traces = engine.readTraces().filter((t) => t.action === 'truncate');
    assert.equal(traces.length, 1);
    assert.equal(traces[0].createdBy, 'sys_reconciler');
    assert.ok((traces[0].meta as { truncatedBytes: number }).truncatedBytes > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R3-21 dual-read shim: reads fall back to legacy root; first write migrates the store; writes only to new root', async () => {
  const base = freshRoot();
  const root = path.join(base, '.novakai');
  const legacy = path.join(base, '.novakai-command');
  try {
    mkdirSync(legacy, { recursive: true });
    // legacy store holds a v0 FLAT record (pre-wrapper format)
    const legacyLine = JSON.stringify({
      kind: 'settings', id: 'settings_legacy', schemaVersion: 1,
      createdAt: '2025-12-01T00:00:00.000Z', permissionLevel: 'private',
      createdBy: 'person_chris', key: 'legacy', value: 'old',
    });
    writeFileSync(path.join(legacy, 'settings.jsonl'), legacyLine + '\n');
    const h = composeHandle({ root, legacyRoot: legacy, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
    // read falls back to the legacy root
    const got = await getObject(h, 'settings', 'settings_legacy' as ObjectId);
    assert.equal(got.ok, true);
    if (got.ok && !isAbsent(got.value)) {
      assert.equal((got.value.object as Record<string, unknown>).key, 'legacy');
    } else {
      assert.fail('legacy record must be readable via the shim');
    }
    // first write triggers lazy per-store migration into the new root
    await createObject(h, settingsPayload('settings_new'), mintClientOpId());
    const migrated = readFileSync(path.join(root, 'settings.jsonl'), 'utf8');
    assert.ok(migrated.includes('settings_legacy')); // migrated history
    assert.ok(migrated.includes('settings_new'));
    // legacy root left untouched
    assert.equal(readFileSync(path.join(legacy, 'settings.jsonl'), 'utf8'), legacyLine + '\n');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('FND-008: legacy flat (v0) records load via lazy upgrade-on-read; the stored line is NEVER rewritten', async () => {
  const root = freshRoot();
  try {
    mkdirSync(root, { recursive: true });
    const flatLine = JSON.stringify({
      kind: 'settings', id: 'settings_v0', schemaVersion: 1,
      createdAt: '2025-11-01T00:00:00.000Z', permissionLevel: 'private',
      createdBy: 'person_legacy', key: 'theme', value: 'light',
    });
    writeFileSync(path.join(root, 'settings.jsonl'), flatLine + '\n');
    const h = composeHandle({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
    const got = await getObject(h, 'settings', 'settings_v0' as ObjectId);
    assert.equal(got.ok, true);
    if (got.ok && !isAbsent(got.value)) {
      assert.equal(got.value.object.createdBy, 'person_legacy');
      assert.equal((got.value.object as Record<string, unknown>).value, 'light');
    } else {
      assert.fail('v0 fixture must load');
    }
    // append-only preserved: the stored line is byte-identical after the read
    assert.equal(readFileSync(path.join(root, 'settings.jsonl'), 'utf8'), flatLine + '\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('§8 rule 3: write with schemaVersion newer than code → rejected; read surfaces the record flagged', async () => {
  const root = freshRoot();
  try {
    const h = composeHandle({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
    const write = await createObject(h, { ...settingsPayload('settings_future'), schemaVersion: 99 }, mintClientOpId());
    assert.equal(write.ok, false);
    if (!write.ok) assert.equal(write.error.code, 'KindUnknown');
    // plant a future-version wrapped record directly; read surfaces flagged
    mkdirSync(root, { recursive: true });
    appendFileSync(path.join(root, 'settings.jsonl'), JSON.stringify({
      envelope: {
        kind: 'settings', id: 'settings_v99', schemaVersion: 99,
        createdAt: new Date().toISOString(), permissionLevel: 'private', createdBy: 'person_future',
      },
      payload: { key: 'x', value: 1 },
      meta: { opId: 'srv_x', clientOpId: 'op_x', version: 1 },
    }) + '\n');
    const got = await getObject(h, 'settings', 'settings_v99' as ObjectId);
    assert.equal(got.ok, true);
    if (got.ok && !isAbsent(got.value)) {
      assert.equal(got.value.unsupportedVersion, true);
    } else {
      assert.fail('newer-version record must surface as data, never crash');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
