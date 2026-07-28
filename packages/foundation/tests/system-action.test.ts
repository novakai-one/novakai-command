// S2a — named system actions in the trace journal (S2-pass1 §22 rulings 3/9/14):
// hook_log / context.inject / hook_error lines exist alongside mutation traces,
// and the skills registry kind ('skill') round-trips through the scoped handle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '../contract/brands.js';
import { composeHandle } from '../contract/compose.js';
import {
  createObject, getObject, listObjects, queryTraceBound, recordSystemAction,
} from '../contract/api.js';
import { composeEngine } from '../contract/compose.js';

const freshRoot = () => mkdtempSync(path.join(tmpdir(), 'nvk-fnd-sysact-'));

test('recordSystemAction appends an opKind:"system.action" trace line carrying the action + payload', async () => {
  const root = freshRoot();
  const handle = composeHandle({ root, capability: 'agents', allowedKinds: ['agent', 'skill'], principal: 'person_chris' });
  const op = mintClientOpId();
  const res = await recordSystemAction(handle, {
    action: 'context.inject',
    target: { kind: 'agent', id: 'agent_1' },
    clientOpId: op,
    meta: { text: 'injected context text' },
  });
  assert.equal(res.ok, true);
  const engine = composeEngine({ root, capability: 'agents', allowedKinds: ['agent', 'skill'], principal: 'person_chris' });
  const page = await queryTraceBound(engine, { clientOpId: op });
  assert.equal(page.items.length, 1);
  const line = page.items[0];
  assert.equal(line.opKind, 'system.action');
  assert.equal(line.action, 'context.inject');
  assert.equal(line.target.kind, 'agent');
  assert.equal((line.meta as { text: string }).text, 'injected context text');
  assert.equal(line.createdBy, 'person_chris'); // principal-derived, never caller payload
});

test('recordSystemAction retry with the same clientOpId is idempotent', async () => {
  const root = freshRoot();
  const handle = composeHandle({
    root,
    capability: 'agents',
    allowedKinds: ['agent', 'skill'],
    principal: 'person_chris',
  });
  const clientOpId = mintClientOpId();
  const input = {
    action: 'hook_log' as const,
    target: { kind: 'agent', id: 'agent_retry' },
    clientOpId,
    meta: { event: 'retryable.semantic.action' },
  };

  assert.equal((await recordSystemAction(handle, input)).ok, true);
  assert.equal((await recordSystemAction(handle, input)).ok, true);
  assert.equal((await recordSystemAction(handle, {
    ...input,
    meta: { event: 'different.semantic.action' },
  })).ok, true);

  const engine = composeEngine({
    root,
    capability: 'agents',
    allowedKinds: ['agent', 'skill'],
    principal: 'person_chris',
  });
  const page = await queryTraceBound(engine, { clientOpId });
  assert.equal(page.items.length, 2, 'only an exact semantic retry is deduplicated');
});

test('boot reconcile never tombstones system.action traces (no object exists behind the ref)', async () => {
  const root = freshRoot();
  const handle = composeHandle({ root, capability: 'agents', allowedKinds: ['agent', 'skill'], principal: 'person_chris' });
  await recordSystemAction(handle, {
    action: 'hook_error', target: { kind: 'agent', id: 'agent_gone' },
    clientOpId: mintClientOpId(), meta: { reason: 'timeout' },
  });
  // re-boot (fresh engine instance would; here boot is idempotent — use a second compose key)
  const engine2 = composeEngine({ root, capability: 'agents', allowedKinds: ['agent', 'skill'], principal: 'person_chris', lockTimeoutMs: 5001 });
  engine2.boot();
  const { listQuarantineBound } = await import('../contract/api.js');
  const q = await listQuarantineBound(engine2);
  assert.equal(q.items.length, 0);
});

test('kind "skill" round-trips through the scoped handle (skills registry store)', async () => {
  const root = freshRoot();
  const handle = composeHandle({ root, capability: 'agents', allowedKinds: ['agent', 'skill'], principal: 'person_chris' });
  const rec = {
    kind: 'skill', id: 'skill_abc', schemaVersion: 1, createdAt: new Date().toISOString(),
    permissionLevel: 'private', createdBy: 'person_chris',
    name: 'TDD', path: '.novakai/skills/tdd', description: 'test-driven development',
  };
  const created = await createObject(handle, rec, mintClientOpId());
  assert.equal(created.ok, true);
  const got = await getObject(handle, 'skill', 'skill_abc' as never);
  assert.equal(got.ok && !('absent' in got.value), true);
  const listed = await listObjects(handle, 'skill');
  assert.equal(listed.ok && listed.value.items.length, 1);
});
