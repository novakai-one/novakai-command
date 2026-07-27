// Engine behaviors: scope (FND-002), refs/Absent (FND-003), CAS, traces (FND-005).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle, createObject, updateObject, getObject, listObjects, resolveRef,
  queryTraceBound, composeEngine, mintClientOpId, isAbsent,
  type ObjectId, type ScopedStoreHandle,
} from '../contract/index.js';

const freshRoot = () => mkdtempSync(path.join(tmpdir(), 'nvk-fnd-'));

const shellHandle = (root: string): ScopedStoreHandle => composeHandle({
  root, capability: 'shell', allowedKinds: ['settings', 'layout'], principal: 'person_chris',
});

const settingsPayload = (id: string) => ({
  kind: 'settings', id, schemaVersion: 1, createdAt: new Date().toISOString(),
  permissionLevel: 'private', createdBy: 'person_chris', key: id, value: 1,
});

test('FND-002: mis-scoped handle write → ScopeViolation from the ENGINE check', async () => {
  const root = freshRoot();
  try {
    // shell handle is NOT allowed to write agents
    const h = shellHandle(root);
    const res = await createObject(h, {
      kind: 'agent', id: 'agent_x', schemaVersion: 1, createdAt: new Date().toISOString(),
      permissionLevel: 'team', createdBy: 'person_chris',
      displayName: 'X', provider: 'mock', model: 'm', hooks: [], status: 'defined',
    }, mintClientOpId());
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, 'ScopeViolation');
      const d = res.error.details as { capability: string; kind: string; allowedKinds: string[] };
      assert.equal(d.capability, 'shell');
      assert.equal(d.kind, 'agent');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FND-002: unregistered kind → KindUnknown', async () => {
  const root = freshRoot();
  try {
    const h = composeHandle({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'sys_ingester' });
    const res = await createObject(h, settingsPayload('settings_a'), mintClientOpId());
    void res;
    const bogus = await createObject(composeHandle({
      root, capability: 'foundation', allowedKinds: ['settings'], principal: 'sys_ingester',
    }), { ...settingsPayload('s'), kind: 'bogus' }, mintClientOpId());
    assert.equal(bogus.ok, false);
    if (!bogus.ok) assert.equal(bogus.error.code, 'KindUnknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FND-003: ref to a nonexistent id stores cleanly; resolveRef → Absent, never throws', async () => {
  const root = freshRoot();
  try {
    const h = shellHandle(root);
    const res = await resolveRef(h, { kind: 'settings', id: 'settings_ghost' });
    assert.equal(res.ok, true);
    if (res.ok) assert.ok(isAbsent(res.value));
    const got = await getObject(h, 'settings', 'settings_ghost' as ObjectId);
    assert.equal(got.ok, true);
    if (got.ok) assert.ok(isAbsent(got.value));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CAS: updateObject with stale expectedVersion → CasConflict; current version succeeds', async () => {
  const root = freshRoot();
  try {
    const h = shellHandle(root);
    const created = await createObject(h, settingsPayload('settings_theme'), mintClientOpId());
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const stale = await updateObject(h, 'settings_theme' as ObjectId, { value: 2 }, 99, mintClientOpId());
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.error.code, 'CasConflict');
      const d = stale.error.details as { expectedVersion: number; actualVersion: number };
      assert.equal(d.expectedVersion, 99);
      assert.equal(d.actualVersion, 1);
    }
    const good = await updateObject(h, 'settings_theme' as ObjectId, { value: 2 }, 1, mintClientOpId());
    assert.equal(good.ok, true);
    if (good.ok) {
      assert.equal(good.value.version, 2);
      assert.equal((good.value.object as Record<string, unknown>).value, 2);
      assert.equal(good.value.object.createdBy, 'person_chris'); // envelope identity preserved
    }
    const missing = await updateObject(h, 'settings_nope' as ObjectId, { value: 3 }, 1, mintClientOpId());
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, 'NotFound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FND-005: every mutation appends exactly one trace line grouped by opId', async () => {
  const root = freshRoot();
  try {
    const h = shellHandle(root);
    const engine = composeEngine({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
    const cop = mintClientOpId();
    await createObject(h, settingsPayload('settings_a'), cop);
    await updateObject(h, 'settings_a' as ObjectId, { value: 9 }, 1, mintClientOpId());
    const page = await queryTraceBound(engine, { target: { kind: 'settings', id: 'settings_a' } });
    assert.equal(page.items.length, 2);
    const [t1, t2] = page.items;
    assert.equal(t1.action, 'create');
    assert.equal(t2.action, 'update');
    assert.equal(t1.clientOpId, cop);
    assert.equal(t1.createdBy, 'person_chris');
    assert.ok(t1.opId.startsWith('srv_'));
    assert.deepEqual(t1.target, { kind: 'settings', id: 'settings_a' });
    assert.ok(t1.seq < t2.seq); // monotonic seq from lock holder
    assert.ok(Date.parse(t1.createdAt) > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R3-10: retry with same clientOpId returns prior outcome, no double-apply', async () => {
  const root = freshRoot();
  try {
    const h = shellHandle(root);
    const engine = composeEngine({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
    const cop = mintClientOpId();
    const first = await createObject(h, settingsPayload('settings_a'), cop);
    const second = await createObject(h, settingsPayload('settings_a'), cop);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(second.value.version, first.value.version);
    }
    const list = await listObjects(h, 'settings');
    assert.equal(list.ok, true);
    if (list.ok) assert.equal(list.value.items.length, 1); // no double-apply
    const traces = await queryTraceBound(engine, {});
    assert.equal(traces.items.length, 1); // exactly one trace line
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R3-10: injected trace failure → TraceIncomplete; object readable incomplete:true; retry reconciles', async () => {
  const root = freshRoot();
  try {
    const cop = mintClientOpId();
    // fresh engine instance with the failure seam (cache-busted by the seam flag)
    const hFail = composeHandle({
      root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris',
      failNextTraceAppend: { cause: 'injected crash between object and trace append' },
    });
    const res = await createObject(hFail, settingsPayload('settings_b'), cop);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, 'TraceIncomplete');
      assert.equal(res.error.retryable, true);
    }
    // object remains readable, flagged incomplete, NEVER hidden (R3-4 amended)
    const h = shellHandle(root);
    const got = await getObject(h, 'settings', 'settings_b' as ObjectId);
    assert.equal(got.ok, true);
    if (got.ok && !isAbsent(got.value)) {
      assert.equal(got.value.incomplete, true);
    } else {
      assert.fail('incomplete object must remain readable');
    }
    // retry with same clientOpId completes the trace, clears the flag, prior outcome
    const retry = await createObject(h, settingsPayload('settings_b'), cop);
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.value.incomplete, false);
    const engine = composeEngine({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
    const traces = await queryTraceBound(engine, { target: { kind: 'settings', id: 'settings_b' } });
    assert.equal(traces.items.length, 1); // reconciled, not duplicated
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listObjects: ordered by createdAt, paginated, filter equality, FilterInvalid', async () => {
  const root = freshRoot();
  try {
    const h = shellHandle(root);
    await createObject(h, { ...settingsPayload('settings_1'), createdAt: '2026-01-01T00:00:00.000Z', value: 'x' }, mintClientOpId());
    await createObject(h, { ...settingsPayload('settings_2'), createdAt: '2026-01-02T00:00:00.000Z', value: 'y' }, mintClientOpId());
    await createObject(h, { ...settingsPayload('settings_3'), createdAt: '2026-01-03T00:00:00.000Z', value: 'x' }, mintClientOpId());
    const all = await listObjects(h, 'settings');
    assert.equal(all.ok, true);
    if (all.ok) {
      assert.deepEqual(all.value.items.map((i) => i.object.id), ['settings_1', 'settings_2', 'settings_3']);
    }
    const filtered = await listObjects(h, 'settings', { value: 'x' });
    assert.equal(filtered.ok, true);
    if (filtered.ok) assert.equal(filtered.value.items.length, 2);
    const paged = await listObjects(h, 'settings', undefined, { limit: 2 });
    assert.equal(paged.ok, true);
    if (paged.ok) {
      assert.equal(paged.value.items.length, 2);
      assert.equal(paged.value.nextCursor, '2');
    }
    const bad = await listObjects(h, 'settings', 'nope' as unknown as Record<string, unknown>);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, 'FilterInvalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
