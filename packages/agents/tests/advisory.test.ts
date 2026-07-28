// S2b — focus-change advisories via the live lane (DEC-S2-6, §22 ruling 1).
// In-app sessions (IO through the live lane) receive advisories as system
// context lines BETWEEN turns — never mid-stream, never stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentId, SessionId } from '@novakai/foundation/dist/contract/brands.js';
import { mintClientOpId } from '@novakai/foundation/dist/contract/brands.js';
import { composeAgents, mockOf } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(quietMs = 120) {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-advisory-'));
  const ctx = composeAgents({ root, principal: 'person_test', advisoryQuietMs: quietMs });
  const agents = createAgentsContract(ctx);
  const mock = mockOf(ctx)!;
  const def = await agents.defineAgent(
    { displayName: 'Adv', provider: 'mock', model: 'm1', hooks: [], status: 'defined', permissionLevel: 'private' },
    mintClientOpId());
  assert.ok(def.ok);
  const spawn = await agents.spawnAgent(def.value.id as AgentId);
  assert.ok(spawn.ok);
  const sessionId = spawn.value.sessionId as SessionId;
  return { ctx, agents, mock, sessionId };
}

const laneSender = () => ({ async sendMessage() { return { kind: 'ok' as const, value: {} }; } });

test('advisory to an idle live-lane session is delivered immediately as a system context line', async () => {
  const { agents, mock, sessionId } = await setup();
  agents.attachLiveLane({ sessionId, address: 'person:person_chris', sender: laneSender() });
  const okPush = agents.pushContextAdvisory(sessionId, '[novakai context] {"app":"messaging","ref":"none"}');
  assert.equal(okPush, true);
  assert.deepEqual(mock.__session(sessionId)!.sent, ['[novakai context] {"app":"messaging","ref":"none"}']);
});

test('advisory during a turn is HELD, then delivered between turns after the quiet window', async () => {
  const { agents, mock, sessionId } = await setup(120);
  agents.attachLiveLane({ sessionId, address: 'person:person_chris', sender: laneSender() });
  // mid-turn: output is streaming
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'chunk' });
  agents.pushContextAdvisory(sessionId, 'advisory-1');
  assert.deepEqual(mock.__session(sessionId)!.sent, [], 'never mid-stream');
  await sleep(220); // quiet window passes → turn over
  assert.deepEqual(mock.__session(sessionId)!.sent, ['advisory-1']);
});

test('repeated output keeps the turn alive — advisory waits for real quiet', async () => {
  const { agents, mock, sessionId } = await setup(150);
  agents.attachLiveLane({ sessionId, address: 'person:person_chris', sender: laneSender() });
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'a' });
  agents.pushContextAdvisory(sessionId, 'advisory-x');
  await sleep(100);
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'b' }); // extends the turn
  await sleep(100);
  assert.deepEqual(mock.__session(sessionId)!.sent, [], 'still mid-turn');
  await sleep(120);
  assert.deepEqual(mock.__session(sessionId)!.sent, ['advisory-x']);
});

test('advisory queue coalesces latest-wins (ruled): only the LATEST pending advisory is delivered, queue capped at 1', async () => {
  const { agents, mock, sessionId } = await setup(100);
  agents.attachLiveLane({ sessionId, address: 'person:person_chris', sender: laneSender() });
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'chunk' });
  agents.pushContextAdvisory(sessionId, 'stale-first');
  agents.pushContextAdvisory(sessionId, 'latest-second'); // replaces, never queues behind
  await sleep(200);
  assert.deepEqual(mock.__session(sessionId)!.sent, ['latest-second'], 'stale advisories are dropped, latest wins');
});

test('a queued advisory carries a timestamp', async () => {
  const { ctx, agents, mock, sessionId } = await setup(100);
  agents.attachLiveLane({ sessionId, address: 'person:person_chris', sender: laneSender() });
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'chunk' });
  agents.pushContextAdvisory(sessionId, 'stamped');
  const pending = ctx.laneState.get(sessionId)?.pending;
  assert.ok(pending && typeof pending.at === 'string' && !Number.isNaN(Date.parse(pending.at)), 'pending advisory is timestamped');
});

test("M5: activity 'idle' ENDS the turn — it never extends it (queued advisory flushes immediately)", async () => {
  const { agents, mock, sessionId } = await setup(5000); // long quiet window: only an idle event can end the turn
  agents.attachLiveLane({ sessionId, address: 'person:person_chris', sender: laneSender() });
  // real-adapter-style sequence: output chunks (turn starts), working activity, then idle
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'chunk-1' });
  mock.__emit(sessionId, { type: 'activity', sessionId, at: new Date().toISOString(), activity: 'working' });
  agents.pushContextAdvisory(sessionId, 'between-turns');
  assert.deepEqual(mock.__session(sessionId)!.sent, [], 'mid-turn: held');
  mock.__emit(sessionId, { type: 'activity', sessionId, at: new Date().toISOString(), activity: 'idle' });
  assert.deepEqual(mock.__session(sessionId)!.sent, ['between-turns'], 'idle ended the turn — advisory delivered between turns');
});

test("activity events other than 'idle' still extend the turn", async () => {
  const { agents, mock, sessionId } = await setup(150);
  agents.attachLiveLane({ sessionId, address: 'person:person_chris', sender: laneSender() });
  mock.__emit(sessionId, { type: 'activity', sessionId, at: new Date().toISOString(), activity: 'working' });
  agents.pushContextAdvisory(sessionId, 'held');
  await sleep(100);
  mock.__emit(sessionId, { type: 'activity', sessionId, at: new Date().toISOString(), activity: 'watching the thread' });
  await sleep(100);
  assert.deepEqual(mock.__session(sessionId)!.sent, [], 'non-idle activity extended the turn');
  await sleep(120);
  assert.deepEqual(mock.__session(sessionId)!.sent, ['held']);
});

test('sessions WITHOUT a live lane are pull-only (ruling 1): advisory refused', async () => {
  const { agents, mock, sessionId } = await setup();
  const okPush = agents.pushContextAdvisory(sessionId, 'advisory');
  assert.equal(okPush, false);
  assert.deepEqual(mock.__session(sessionId)!.sent, []);
});

test('unknown session → advisory refused, never silent', async () => {
  const { agents } = await setup();
  assert.equal(agents.pushContextAdvisory('sess_nope' as SessionId, 'advisory'), false);
});
