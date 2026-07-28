// Slice 1 — registry CRUD through foundation: envelope/trace laws hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId } from '@novakai/foundation/dist/contract/brands.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import { queryTraceBound } from '@novakai/foundation/dist/contract/index.js';
// M11: composeEngine is foundation-internal (the public surface exports composeHandle only).
import { composeEngine } from '@novakai/foundation/dist/contract/compose.js';
import { composeAgents } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';

function freshCtx() {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-reg-'));
  const ctx = composeAgents({ root, principal: 'person_chris' });
  return { root, ctx, agents: createAgentsContract(ctx) };
}

test('defineAgent stores a lite definition; foundation stamps createdBy from the principal', async () => {
  const { agents } = freshCtx();
  const res = await agents.defineAgent(
    { displayName: 'Fable', provider: 'mock', model: 'mock-1', permissionLevel: 'private', hooks: [], status: 'defined' },
    mintClientOpId());
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.value.id, /^agent_/);
  assert.equal(res.value.createdBy, 'person_chris'); // red gate 4: never caller payload
  assert.equal(res.value.kind, 'agent');
  assert.equal(res.value.schemaVersion, 1);
});

test('getAgent: absence is typed Absent, never a throw', async () => {
  const { agents } = freshCtx();
  const res = await agents.getAgent('agent_nonexistent' as AgentId);
  assert.equal(res.ok && isAbsent(res.value), true);
});

test('define → get → list round-trip; filter by provider', async () => {
  const { agents } = freshCtx();
  await agents.defineAgent({ displayName: 'A', provider: 'mock', model: 'm1', permissionLevel: 'private', hooks: [], status: 'defined' }, mintClientOpId());
  await agents.defineAgent({ displayName: 'B', provider: 'kimi', model: 'k2', permissionLevel: 'team', hooks: [], status: 'defined' }, mintClientOpId());
  const all = await agents.listAgents();
  assert.equal(all.ok && all.value.items.length, 2);
  const kimiOnly = await agents.listAgents({ provider: 'kimi' });
  assert.equal(kimiOnly.ok && kimiOnly.value.items.length, 1);
  assert.equal(kimiOnly.ok && kimiOnly.value.items[0].displayName, 'B');
});

test('every mutation writes exactly one trace line carrying clientOpId + createdBy (FND-005, R3-10)', async () => {
  const { root, ctx, agents } = freshCtx();
  const op = mintClientOpId();
  const res = await agents.defineAgent(
    { displayName: 'Traced', provider: 'mock', model: 'm', permissionLevel: 'private', hooks: [], status: 'defined' }, op);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const engine = composeEngine({ root, capability: 'agents', allowedKinds: ['agent'], principal: 'person_chris' });
  const page = await queryTraceBound(engine, { clientOpId: op });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].action, 'create');
  assert.equal(page.items[0].target.kind, 'agent');
  assert.equal(page.items[0].target.id, res.value.id);
  assert.equal(page.items[0].createdBy, 'person_chris');
  void ctx;
});

test('retry with the same clientOpId returns the prior outcome, no double-apply (R3-10)', async () => {
  const { agents } = freshCtx();
  const op = mintClientOpId();
  const def = { displayName: 'Once', provider: 'mock' as const, model: 'm', permissionLevel: 'private' as const, hooks: [], status: 'defined' as const };
  const first = await agents.defineAgent(def, op);
  const second = await agents.defineAgent(def, op);
  assert.equal(first.ok && second.ok, true);
  if (first.ok && second.ok) assert.equal(first.value.id, second.value.id);
  const all = await agents.listAgents();
  assert.equal(all.ok && all.value.items.length, 1);
});

test('updateAgent honors CAS; stale expectedVersion → CasConflict (retryable)', async () => {
  const { agents } = freshCtx();
  const created = await agents.defineAgent(
    { displayName: 'CAS', provider: 'mock', model: 'm', permissionLevel: 'private', hooks: [], status: 'defined' }, mintClientOpId());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const bad = await agents.updateAgent(created.value.id as AgentId, { displayName: 'X' }, 99, mintClientOpId());
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.error.code, 'CasConflict');
    assert.equal(bad.error.retryable, true);
  }
});

test('setModel writes agents.jsonl (R3-22 model authority); next read reflects it', async () => {
  const { agents } = freshCtx();
  const created = await agents.defineAgent(
    { displayName: 'Modelled', provider: 'mock', model: 'old', permissionLevel: 'private', hooks: [], status: 'defined' }, mintClientOpId());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const updated = await agents.setModel(created.value.id as AgentId, 'new-model', mintClientOpId());
  assert.equal(updated.ok && updated.value.model, 'new-model');
  const read = await agents.getAgent(created.value.id as AgentId);
  assert.equal(read.ok && !isAbsent(read.value) && read.value.model, 'new-model');
});
