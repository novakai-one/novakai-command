// Slice 2 — spawn via the adapter seam + agentEvent emission (R3-17, §7.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId, type SessionId } from '@novakai/foundation/dist/contract/brands.js';
import type { AgentEvent } from '../contract/schemas.js';
import { composeAgents, mockOf, type AgentsContext } from '../core/composition.js';
import { createAgentsContract, type AgentsContract } from '../core/contract.js';

async function freshWithAgent() {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-spawn-'));
  const ctx = composeAgents({ root, principal: 'person_chris' });
  const agents = createAgentsContract(ctx);
  const def = await agents.defineAgent(
    { displayName: 'Runner', provider: 'mock', model: 'mock-1', permissionLevel: 'private', hooks: [], status: 'defined' },
    mintClientOpId());
  assert.equal(def.ok, true);
  if (!def.ok) throw new Error('setup failed');
  return { ctx, agents, agentId: def.value.id as AgentId };
}

function collectEvents(agents: AgentsContract): AgentEvent[] {
  const events: AgentEvent[] = [];
  agents.subscribeAgentEvents((e) => events.push(e));
  return events;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test('spawnAgent returns the resolved model and publishes spawned + online', async () => {
  const { agents, agentId } = await freshWithAgent();
  const events = collectEvents(agents);
  const res = await agents.spawnAgent(agentId);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.value.sessionId, /^sess_/);
  assert.equal(res.value.agentId, agentId);
  assert.equal(res.value.model, 'mock-1'); // def model resolved
  assert.deepEqual(events.map((e) => e.type), ['spawned', 'online']);
  assert.equal(events[0].sessionId, res.value.sessionId);
});

test('at-spawn model override is GUARANTEED (AGT-003)', async () => {
  const { agents, agentId } = await freshWithAgent();
  const res = await agents.spawnAgent(agentId, { model: 'override-x' });
  assert.equal(res.ok && res.value.model, 'override-x');
});

test('spawnAgent on an unknown agentId is a typed NotFound, never a throw', async () => {
  const { agents } = await freshWithAgent();
  const res = await agents.spawnAgent('agent_ghost' as AgentId);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'NotFound');
});

test('terminal activity/exit re-publish as agentEvent activity / offline(exited) (R3-17)', async () => {
  const { ctx, agents, agentId } = await freshWithAgent();
  const events = collectEvents(agents);
  const res = await agents.spawnAgent(agentId);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const mock = mockOf(ctx);
  assert.ok(mock);
  mock.__emit(res.value.sessionId, { type: 'activity', sessionId: res.value.sessionId, at: new Date().toISOString(), activity: 'thinking' });
  mock.__emit(res.value.sessionId, { type: 'exited', sessionId: res.value.sessionId, at: new Date().toISOString(), code: 0, signal: null });
  assert.deepEqual(events.map((e) => e.type), ['spawned', 'online', 'activity', 'offline']);
  const off = events[3];
  assert.equal(off.type === 'offline' && off.reason, 'exited');
});

test('closeSession maps the exit to offline(closed) (§7.2)', async () => {
  const { agents, agentId } = await freshWithAgent();
  const events = collectEvents(agents);
  const res = await agents.spawnAgent(agentId);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  await tick();
  assert.equal(agents.closeSession(res.value.sessionId as SessionId), true);
  await tick();
  const off = events.find((e) => e.type === 'offline');
  assert.equal(off?.type === 'offline' && off.reason, 'closed');
});

test('provider spawn failure = typed SpawnFailed + presence offline(provider_error), never silent (C §11)', async () => {
  const { ctx, agents, agentId } = await freshWithAgent();
  const events = collectEvents(agents);
  const mock = mockOf(ctx);
  assert.ok(mock);
  mock.spawn = () => Promise.reject(new Error('pty boom'));
  const res = await agents.spawnAgent(agentId);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'SpawnFailed');
  const off = events.find((e) => e.type === 'offline');
  assert.equal(off?.type === 'offline' && off.reason, 'provider_error');
});

test('send routes input to the live session (terminal mini-contract send)', async () => {
  const { ctx, agents, agentId } = await freshWithAgent();
  const res = await agents.spawnAgent(agentId);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const mock = mockOf(ctx);
  assert.ok(mock);
  assert.equal(mock.send(res.value.sessionId, 'hello pty'), true);
  assert.deepEqual(mock.__session(res.value.sessionId)?.sent, ['hello pty']);
});
