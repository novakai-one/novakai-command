// S2a — agent definition v2 (AGT-004, DEC-S2-1, §22 ruling 4): displayName,
// provider, model, instructions, hooks (subscriptions on the object), skills
// (id refs), permissionLevel = envelope only. Upgrade-on-read from S1 lite defs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId } from '@novakai/foundation/dist/contract/brands.js';
import { createObject } from '@novakai/foundation/dist/contract/index.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import { composeAgents } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';

function freshCtx() {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-v2-'));
  const ctx = composeAgents({ root, principal: 'person_chris' });
  return { root, ctx, agents: createAgentsContract(ctx) };
}

test('defineAgent v2: instructions, skills and hooks round-trip through the store', async () => {
  const { agents } = freshCtx();
  const res = await agents.defineAgent({
    displayName: 'Fable', provider: 'kimi', model: 'kimi-k2',
    instructions: 'be brief',
    skills: ['skill_a', 'skill_b'],
    hooks: [{ event: 'onSpawn', action: { kind: 'inject-context-text', text: 'hello' } }],
    permissionLevel: 'private', status: 'defined',
  }, mintClientOpId());
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.instructions, 'be brief');
  assert.deepEqual(res.value.skills, ['skill_a', 'skill_b']);
  assert.equal(res.value.hooks.length, 1);
  assert.match(res.value.hooks[0].id, /^hook_/);
  assert.equal(res.value.hooks[0].event, 'onSpawn');

  const got = await agents.getAgent(res.value.id as AgentId);
  assert.equal(got.ok && !isAbsent(got.value), true);
  if (got.ok && !isAbsent(got.value)) {
    assert.equal(got.value.instructions, 'be brief');
    assert.deepEqual(got.value.skills, ['skill_a', 'skill_b']);
    assert.equal(got.value.hooks.length, 1);
    assert.equal(got.value.permissionLevel, 'private'); // envelope only — no def-level permission field
    assert.equal('permission' in got.value, false);
  }
});

test('defineAgent v2 defaults: instructions "", skills [], hooks []', async () => {
  const { agents } = freshCtx();
  const res = await agents.defineAgent(
    { displayName: 'Plain', provider: 'mock', model: 'm' }, mintClientOpId());
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.instructions, '');
  assert.deepEqual(res.value.skills, []);
  assert.deepEqual(res.value.hooks, []);
});

test('upgrade-on-read: an S1 lite def (Ref[] hooks, no skills/instructions) reads as v2 (DEC-F10)', async () => {
  const { root, ctx, agents } = freshCtx();
  // write a legacy lite record directly through foundation
  const lite = {
    kind: 'agent', id: 'agent_legacy', schemaVersion: 1, createdAt: new Date().toISOString(),
    permissionLevel: 'private', createdBy: 'person_chris',
    displayName: 'Legacy', provider: 'mock', model: 'm1',
    hooks: [{ kind: 'agent', id: 'agent_other' }], // S1 placeholder Ref[]
    status: 'defined',
  };
  const created = await createObject(ctx.handle, lite, mintClientOpId());
  assert.equal(created.ok, true);
  const got = await agents.getAgent('agent_legacy' as AgentId);
  assert.equal(got.ok && !isAbsent(got.value), true);
  if (got.ok && !isAbsent(got.value)) {
    assert.equal(got.value.displayName, 'Legacy');
    assert.deepEqual(got.value.hooks, []);        // uninterpretable placeholder refs -> empty subscriptions
    assert.deepEqual(got.value.skills, []);
    assert.equal(got.value.instructions, '');
  }
});

test('updateAgent patches v2 fields (single-object mutation, R3-18); CAS still enforced', async () => {
  const { agents } = freshCtx();
  const created = await agents.defineAgent(
    { displayName: 'Edit me', provider: 'mock', model: 'm' }, mintClientOpId());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const id = created.value.id as AgentId;
  const updated = await agents.updateAgent(id,
    { instructions: 'new instructions', skills: ['skill_x'] }, 1, mintClientOpId());
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.value.instructions, 'new instructions');
  assert.deepEqual(updated.value.skills, ['skill_x']);
  const stale = await agents.updateAgent(id, { instructions: 'stale' }, 1, mintClientOpId());
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, 'CasConflict');
});
