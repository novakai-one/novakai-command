// Transcript-first lane: PTY output is activity telemetry only. Provider-owned
// session files are the sole message-content authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId } from '@novakai/foundation/dist/contract/brands.js';
import { composeAgents, mockOf } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-live-'));
  const ctx = composeAgents({ root, principal: 'person_chris' });
  const agents = createAgentsContract(ctx);
  const def = await agents.defineAgent(
    { displayName: 'Talker', provider: 'mock', model: 'mock-1', permissionLevel: 'private', hooks: [], status: 'defined' },
    mintClientOpId());
  assert.equal(def.ok, true);
  if (!def.ok) throw new Error('setup failed');
  const spawn = await agents.spawnAgent(def.value.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) throw new Error('setup failed');
  return { ctx, agents, sessionId: spawn.value.sessionId };
}

test('live lane: PTY output never becomes message content', async () => {
  const { ctx, agents, sessionId } = await setup();
  agents.attachLiveLane({ sessionId, address: 'thread:thread_abc' });
  const mock = mockOf(ctx);
  assert.ok(mock);
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'Chris, the reply is 42' });
  assert.deepEqual(mock.__session(sessionId)?.sent, []);
});

test('live lane: input reaches the PTY while output remains telemetry', async () => {
  const { ctx, agents, sessionId } = await setup();
  agents.attachLiveLane({ sessionId, address: 'thread:thread_abc' });
  const mock = mockOf(ctx);
  assert.ok(mock);
  // human → PTY
  assert.equal(mock.send(sessionId, 'what is the answer?\n'), true);
  assert.deepEqual(mock.__session(sessionId)?.sent, ['what is the answer?\n']);
  // PTY output is not a message; ingestion owns the return path.
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: '42' });
  assert.deepEqual(mock.__session(sessionId)?.sent, ['what is the answer?\n']);
});

test('unsubscribing the live lane stops the flow; non-output events never message', async () => {
  const { ctx, agents, sessionId } = await setup();
  const unsub = agents.attachLiveLane({ sessionId, address: 'thread:thread_abc' });
  const mock = mockOf(ctx);
  assert.ok(mock);
  mock.__emit(sessionId, { type: 'activity', sessionId, at: new Date().toISOString(), activity: 'thinking' });
  assert.equal(ctx.laneState.has(sessionId), true);
  unsub();
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'late' });
  assert.equal(ctx.laneState.has(sessionId), false);
});
