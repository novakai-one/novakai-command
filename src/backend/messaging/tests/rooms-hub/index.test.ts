// Free-room archive shim tests over the hub's REST surface (N3): browser
// room creation + list read the ARCHIVED rooms.jsonl through the shim; the
// agent-trusting room routes (POST /api/rooms, /api/rooms/:id/members) are
// deleted with the router's room arms. Run with
// `npx tsx src/backend/messaging/tests/rooms-hub/index.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { MessagingHub } from '../../index.js';
import type { AgentInfo } from '../../../terminal/manager.js';
import type { Room } from '../../types.js';

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
const broadcasts: Array<{ event: string; payload: unknown }> = [];
const messagingHub = new MessagingHub(
  {
    list: () => agents,
    write: () => true,
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
  // Deleted routes answer express's plain-text 404 — never JSON-parse that.
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function testShimLifecycle(): Promise<void> {
  const created = await request('/api/user/rooms', 'POST', {
    name: 'Tunnel Builders',
    members: ['codex-1'],
  });
  assert.equal(created.status, 201);
  const room = created.json.room as Room;
  assert.deepEqual(room.members, ['codex-1', 'chris'], 'the browser identity always joins');
  assert.equal(room.createdBy, 'chris', 'server-stamped creator — no from field accepted');

  const roomEvents = broadcasts.filter((entry) => entry.event === 'rooms-changed');
  assert.equal(roomEvents.length, 1, 'creation broadcasts rooms-changed for the shim');
  assert.deepEqual(roomEvents[0]?.payload, { rooms: [room] });
  assert.deepEqual((await request('/api/rooms')).json.rooms, [room], 'list reads the archive fold');
}

async function testDeletedRoomRoutesAreGone(): Promise<void> {
  const agentCreate = await request('/api/rooms', 'POST', {
    name: 'x', members: ['codex-1'], from: 'claude-1',
  });
  assert.equal(agentCreate.status, 404, 'POST /api/rooms (from-trusting) is deleted');
  const members = await request('/api/rooms/room_x/members', 'POST', { 'add': ['y'], from: 'claude-1' });
  assert.equal(members.status, 404, 'POST /api/rooms/:id/members is deleted');
}

async function testInvalidInputs(): Promise<void> {
  assert.equal((await request('/api/user/rooms', 'POST', { members: [] })).status, 400);
  assert.equal((await request('/api/user/rooms', 'POST', {
    name: 'Bad Members',
    members: 'codex-1',
  })).status, 400);
}

try {
  await testShimLifecycle();
  await testDeletedRoomRoutesAreGone();
  await testInvalidInputs();
  console.log('PASS');
} finally {
  server.close();
}
