// S2a — skills store v1 (S2-pass1 §C + §22 ruling 5): provider-neutral skill
// registry (kind 'skill') via foundation; adapters receive the resolved skill
// dirs at spawn (mock records the list — inert-registry-only = gate failure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId } from '@novakai/foundation/dist/contract/brands.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import { composeAgents } from '../core/composition.js';
import { createAgentsContract, type AgentsContract } from '../core/contract.js';
import { mockOf } from '../core/composition.js';

function freshCtx() {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-skills-'));
  const ctx = composeAgents({ root, principal: 'person_chris' });
  return { root, ctx, agents: createAgentsContract(ctx) };
}

async function registerSkill(agents: AgentsContract, name: string, skillPath: string) {
  const res = await agents.registerSkill({ name, path: skillPath, description: `${name} skill` }, mintClientOpId());
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('registerSkill failed');
  return res.value;
}

test('registerSkill/listSkills/getSkill round-trip; foundation stamps createdBy', async () => {
  const { agents } = freshCtx();
  const a = await registerSkill(agents, 'TDD', '.novakai/skills/tdd');
  assert.match(a.id, /^skill_/);
  assert.equal(a.kind, 'skill');
  assert.equal(a.name, 'TDD');
  assert.equal(a.path, '.novakai/skills/tdd');
  assert.equal(a.createdBy, 'person_chris');

  await registerSkill(agents, 'Review', '.novakai/skills/review');
  const list = await agents.listSkills();
  assert.equal(list.ok && list.value.items.length, 2);

  const got = await agents.getSkill(a.id);
  assert.equal(got.ok && !isAbsent(got.value) && got.value.name, 'TDD');
  const missing = await agents.getSkill('skill_nope');
  assert.equal(missing.ok && isAbsent(missing.value), true);
});

test('registerSkill rejects an empty name or path (typed, never silent)', async () => {
  const { agents } = freshCtx();
  const bad = await agents.registerSkill({ name: '', path: '.novakai/skills/x' }, mintClientOpId());
  assert.equal(bad.ok, false);
  const bad2 = await agents.registerSkill({ name: 'X', path: '' }, mintClientOpId());
  assert.equal(bad2.ok, false);
});

test('spawn resolves the def\'s skill ids and hands the DIRS to the adapter (mock records them)', async () => {
  const { ctx, agents } = freshCtx();
  const s1 = await registerSkill(agents, 'TDD', '.novakai/skills/tdd');
  const s2 = await registerSkill(agents, 'Review', '.novakai/skills/review');
  const def = await agents.defineAgent({
    displayName: 'Skilled', provider: 'mock', model: 'm', skills: [s1.id, s2.id],
  }, mintClientOpId());
  assert.equal(def.ok, true);
  if (!def.ok) return;
  const spawn = await agents.spawnAgent(def.value.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  const rec = mockOf(ctx)!.__session(spawn.value.sessionId)!;
  assert.deepEqual(rec.skills, ['.novakai/skills/tdd', '.novakai/skills/review']); // def order
});

test('spawn with an unknown skill id fails typed (NotFound) — no silent drop', async () => {
  const { agents } = freshCtx();
  const def = await agents.defineAgent({
    displayName: 'Broken', provider: 'mock', model: 'm', skills: ['skill_missing'],
  }, mintClientOpId());
  assert.equal(def.ok, true);
  if (!def.ok) return;
  const spawn = await agents.spawnAgent(def.value.id as AgentId);
  assert.equal(spawn.ok, false);
  if (!spawn.ok) assert.equal(spawn.error.code, 'NotFound');
});
