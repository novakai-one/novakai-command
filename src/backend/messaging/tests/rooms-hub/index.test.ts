/* eslint-disable max-lines-per-function */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { MessagingHub } from '../../index.js';
import type { AgentInfo } from '../../../terminal/manager.js';
import type { MessageEnvelope, Room } from '../../types.js';

function agent(agentId: string, title: string, provider: 'claude' | 'codex'): AgentInfo {
  return {
    agentId,
    title,
    provider,
    sessionId: 'session',
    projectDir: 'project',
    cwd: '/tmp/project',
    status: 'running',
    createdAt: new Date().toISOString(),
  };
}

const root = mkdtempSync(join(tmpdir(), 'nvk-rooms-hub-'));
const agents = [
  agent('agent_claude', 'claude-1', 'claude'),
  agent('agent_codex', 'codex-1', 'codex'),
];
const writes: Array<{ agentId: string; data: string }> = [];
const broadcasts: Array<{ event: string; payload: unknown }> = [];
const messagingHub = new MessagingHub(
  {
    list: () => agents,
    write: (agentId, data) => {
      writes.push({ agentId, data });
      return true;
    },
  },
  (event, payload) => broadcasts.push({ event, payload }),
  {
    storePath: join(root, 'messages.jsonl'),
    roomsStorePath: join(root, 'rooms.jsonl'),
    timings: { interruptSettleMs: 0, submitDelayMs: 0 },
  },
);

const application = express();
application.use(express.json());
messagingHub.registerRoutes(application);
const server: Server = await new Promise((resolve) => {
  const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
});
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}

async function testRoomLifecycle(): Promise<Room> {
  const created = await request('/api/rooms', 'POST', {
    name: 'Tunnel Builders',
    members: ['codex-1', 'chris'],
    from: 'claude-1',
  });
  assert.equal(created.status, 201);
  const room = created.json.room as Room;
  assert.deepEqual(room.members, ['codex-1', 'chris', 'claude-1']);

  const roomEvents = broadcasts.filter((entry) => entry.event === 'rooms-changed');
  assert.equal(roomEvents.length, 1);
  assert.deepEqual(roomEvents[0]?.payload, { rooms: [room] });
  assert.deepEqual((await request('/api/rooms')).json.rooms, [room]);

  const forbidden = await request(`/api/rooms/${room.roomId}/members`, 'POST', {
    'add': ['outsider'],
    from: 'not-a-member',
  });
  assert.equal(forbidden.status, 403);
  const amended = await request(`/api/rooms/${room.roomId}/members`, 'POST', {
    'add': ['claude-2'],
    from: 'claude-1',
  });
  assert.equal(amended.status, 200);
  assert.ok(amended.json.room.members.includes('claude-2'));
  assert.equal(
    (await request('/api/rooms/room_unknown/members', 'POST', {
      'add': ['codex-2'],
      from: 'claude-1',
    })).status,
    404,
  );
  return amended.json.room as Room;
}

async function testRoomMessaging(room: Room): Promise<void> {
  writes.length = 0;
  // N2: POST /api/messages is gone — room routing (which survives until N3)
  // is exercised through the same SendApi seam the old route wrapped.
  const envelope = await messagingHub.send.send('claude-1', {
    'to': room.roomId,
    delivery: 'normal',
    body: 'three-way hello',
  });
  assert.equal(envelope.status, 'delivered');
  assert.equal(writes[0]?.agentId, 'agent_codex');
  assert.equal(
    writes[0]?.data,
    `[nvk-room Tunnel Builders from claude-1 id ${envelope.id}] three-way hello`,
  );
  assert.ok(broadcasts.some((entry) => entry.event === 'message-envelope'));

  const history = await request(`/api/messages?withRoom=${encodeURIComponent(room.roomId)}`);
  assert.deepEqual(history.json.messages.map((message: MessageEnvelope) => message.id), [envelope.id]);

  await assert.rejects(
    messagingHub.send.send('claude-1', { 'to': room.roomId, delivery: 'interrupt', body: 'never record this' }),
    /interrupt/,
  );
  const afterInterrupt = await request(`/api/messages?withRoom=${encodeURIComponent(room.roomId)}`);
  assert.equal(afterInterrupt.json.messages.length, 1, 'room interrupt rejected before recording');

  await assert.rejects(
    messagingHub.send.send('outsider', { 'to': room.roomId, delivery: 'normal', body: 'no access' }),
    /is not a member of room/,
  );
  await assert.rejects(
    messagingHub.send.send('claude-1', { 'to': 'room_unknown', delivery: 'normal', body: 'missing' }),
    /was not found/,
  );
}

async function testInvalidInputs(): Promise<void> {
  assert.equal((await request('/api/rooms', 'POST', { members: [], from: 'chris' })).status, 400);
  assert.equal((await request('/api/rooms', 'POST', {
    name: 'Bad Members',
    members: 'codex-1',
    from: 'chris',
  })).status, 400);
}

try {
  const room = await testRoomLifecycle();
  await testRoomMessaging(room);
  await testInvalidInputs();
  console.log('PASS');
} finally {
  server.close();
}
