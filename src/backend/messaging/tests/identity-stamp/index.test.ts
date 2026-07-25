// Server-derived envelope identity + the mission↔room thread link (plan v2
// §1.5, rulings S2/M11). Run with
// `npx tsx src/backend/messaging/tests/identity-stamp/index.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { MessagingHub } from '../../index.js';
import type { MessageEnvelope } from '../../index.js';
import { EnvelopeIdentity } from '../../identity/index.js';
import { ObjectModel } from '../../../objectModel/index.js';
import type { AgentInfo } from '../../../terminal/manager.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-identity-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'), [
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }),
    JSON.stringify({ id: 'mission_beta', kind: 'mission', 'ts': STAMP, title: 'Beta', owner: 'chief' }),
  ].join('\n') + '\n');
  writeFileSync(path.join(scratch, 'teams.jsonl'), [
    JSON.stringify({ id: 'team_alpha', kind: 'team', 'ts': STAMP, name: 'Alpha', refs: [{ kind: 'mission', value: 'mission_alpha' }] }),
    JSON.stringify({ id: 'team_beta', kind: 'team', 'ts': STAMP, name: 'Beta', refs: [{ kind: 'mission', value: 'mission_beta' }] }),
  ].join('\n') + '\n');
  return scratch;
}

const storesDir = scratchStores();
const model = new ObjectModel({ storesDir });
const workerId = model.createAgent({ name: 'worker-1', provider: 'claude', teamId: 'team_alpha', missionId: 'mission_alpha' });
const managerId = model.createAgent({ name: 'manager-1', provider: 'kimi', teamId: 'team_alpha', missionId: 'mission_alpha' });
const strangerId = model.createAgent({ name: 'stranger-1', provider: 'codex', teamId: 'team_beta', missionId: 'mission_beta' });

function agentInfo(agentId: string, title: string): AgentInfo {
  return {
    agentId, title, provider: 'claude', sessionId: 's',
    projectDir: 'p', cwd: '/tmp/p', status: 'running', createdAt: new Date().toISOString(),
  };
}

const agents: AgentInfo[] = [
  agentInfo(workerId, 'worker-1'),
  agentInfo(managerId, 'manager-1'),
  agentInfo(strangerId, 'stranger-1'),
  agentInfo('agent_plain', 'plain-1'), // live, but outside the mission model
];

// --- pure stamp rules --------------------------------------------------------

{
  const identity = new EnvelopeIdentity(model);
  const roster = agents.map((agent) => ({ agentId: agent.agentId, name: agent.title, provider: agent.provider }));
  const envelope = (from: string, recipient: string): MessageEnvelope => ({
    'id': 'msg_x', from, 'to': recipient, delivery: 'normal', body: 'b', createdAt: STAMP, status: 'queued',
  });

  const sameMission = envelope('worker-1', 'manager-1');
  identity.stamp(sameMission, roster);
  assert.equal(sameMission.senderAgentId, workerId);
  assert.equal(sameMission.recipientAgentId, managerId);
  assert.equal(sameMission.missionId, 'mission_alpha', 'shared mission stamps the DM');

  const crossMission = envelope('worker-1', 'stranger-1');
  identity.stamp(crossMission, roster);
  assert.equal(crossMission.recipientAgentId, strangerId);
  assert.equal(crossMission.missionId, undefined, 'different missions — never guessed');

  const toPlain = envelope('worker-1', 'plain-1');
  identity.stamp(toPlain, roster);
  assert.equal(toPlain.senderAgentId, workerId);
  assert.equal(toPlain.recipientAgentId, undefined, 'non-model Presence gets no durable id');
  assert.equal(toPlain.missionId, undefined);

  const toMailbox = envelope('worker-1', 'chris');
  identity.stamp(toMailbox, roster);
  assert.equal(toMailbox.senderAgentId, workerId);
  assert.equal(toMailbox.missionId, undefined, 'mailboxes have no mission');

  const channel = envelope('worker-1', '#team');
  identity.stamp(channel, roster);
  assert.equal(channel.senderAgentId, workerId);
  assert.equal(channel.missionId, undefined);
  console.log('stamp rule tests passed');
}

// --- through the hub: thread link, room stamping, missionId history ----------
// N2: POST /api/messages is gone — sends ride the same SendApi seam the old
// route wrapped (the route also dropped client-supplied missionId; SendApi
// never accepted it, so server derivation is the only missionId source).

const messagingHub = new MessagingHub(
  { list: () => agents, write: () => true },
  () => {},
  {
    storePath: join(mkdtempSync(join(tmpdir(), 'nvk-identity-store-')), 'messages.jsonl'),
    roomsStorePath: join(mkdtempSync(join(tmpdir(), 'nvk-identity-rooms-')), 'rooms.jsonl'),
    timings: { interruptSettleMs: 0, submitDelayMs: 0 },
    missionGraph: model,
  },
);
const application = express();
application.use(express.json());
messagingHub.registerRoutes(application);
const server: Server = await new Promise((resolve) => {
  const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function post(route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

// Create a room, link it to the mission, post into it.
const roomResponse = await post('/api/rooms', { name: 'alpha-room', members: ['worker-1', 'manager-1'], from: 'worker-1' });
assert.equal(roomResponse.status, 201);
const roomId = (roomResponse.json.room as { roomId: string }).roomId;

assert.equal((await post('/api/threads', { roomId, missionId: 'mission_alpha' })).status, 201);
assert.equal((await post('/api/threads', { roomId, missionId: 'mission_beta' })).status, 409, 'a room links to one mission');
assert.equal((await post('/api/threads', { roomId: 'room_ghost', missionId: 'mission_alpha' })).status, 404);

const roomEnvelope = await messagingHub.send.send('worker-1', { 'to': roomId, delivery: 'normal', body: 'room ping' });
assert.equal(roomEnvelope.missionId, 'mission_alpha', 'room send carries the linked mission');

const dmEnvelope = await messagingHub.send.send('worker-1', { 'to': 'manager-1', delivery: 'normal', body: 'dm ping' });
assert.equal(dmEnvelope.missionId, 'mission_alpha', 'server derivation is the only missionId source');

const history = await fetch(`${base}/api/messages?missionId=mission_alpha`);
const messages = (await history.json() as { messages: MessageEnvelope[] }).messages;
assert.equal(messages.length >= 2, true);
assert.ok(messages.every((message) => message.missionId === 'mission_alpha'), 'history filters by mission');
console.log('hub thread-link + history tests passed');

server.close();
rmSync(storesDir, { recursive: true, force: true });
console.log('envelope identity tests passed');
