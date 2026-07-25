// MessagingHub sliver + AgentsHub REST tests (N4): the hub shrank to
// mailbox registration + POST /api/threads; AgentsHub spawn rules are
// unchanged. The old tunnel routes (GET /api/messages, /api/user/messages,
// rooms) are deleted — their tests went with them. Run with
// `npx tsx src/backend/messaging/tests/api.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { MailboxRegistry, MessagingHub } from '../index.js';
import { AgentsHub } from '../../server/agents.js';
import type { AgentInfo, CreateAgentOptions } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    agentId: 'agent_x', title: 'claude-1', provider: 'claude', sessionId: 'session',
    projectDir: 'project', cwd: '/tmp/project', status: 'running', createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const agents: AgentInfo[] = [
  agent({ agentId: 'agent_1', title: 'claude-1' }),
  agent({ agentId: 'agent_2', title: 'codex-1', provider: 'codex' }),
];

const messagingHub = new MessagingHub({
  mailboxRegistry: MailboxRegistry.inMemory(),
  roomsStorePath: join(mkdtempSync(join(tmpdir(), 'nvk-api-')), 'rooms.jsonl'),
});
const application = express();
application.use(express.json());
messagingHub.registerRoutes(application);
const server: Server = await new Promise((resolve) => {
  const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
});
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function post(route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function testMailboxRegisterRoute(): Promise<void> {
  const created = await post('/api/mailboxes', { displayName: 'Manager K3', memberName: 'manager-k3' });
  assert.equal(created.status, 201);
  const conflict = await post('/api/mailboxes', { displayName: 'Twin', memberName: 'manager-k3' });
  assert.equal(conflict.status, 409);
  const invalid = await post('/api/mailboxes', { displayName: '', memberName: 'x' });
  assert.equal(invalid.status, 400);
  console.log('mailbox register route tests passed');
}

async function testThreadsLinkValidatesAgainstTheArchive(): Promise<void> {
  // No mission graph on this hub → the route honestly 501s (the stores-gated
  // link is exercised end-to-end in missionView's own suite).
  const noGraph = await post('/api/threads', { roomId: 'room_x', missionId: 'mission_alpha' });
  assert.equal(noGraph.status, 501);
  console.log('threads link tests passed');
}

async function testDeletedRoutesAreGone(): Promise<void> {
  const history = await fetch(`${baseUrl}/api/messages`);
  assert.equal(history.status, 404, 'GET /api/messages is deleted (N4)');
  const userSend = await post('/api/user/messages', { 'to': 'claude-1', body: 'x' });
  assert.equal(userSend.status, 404, 'POST /api/user/messages is deleted (N4)');
  const rooms = await fetch(`${baseUrl}/api/rooms`);
  assert.equal(rooms.status, 404, 'GET /api/rooms is deleted (N4)');
  const identity = await fetch(`${baseUrl}/api/identity`);
  assert.equal(identity.status, 404, 'GET /api/identity is deleted (N4)');
  const addressBook = await fetch(`${baseUrl}/api/messaging/address-book`);
  assert.equal(addressBook.status, 404, 'the old address-book is deleted (agents use v2)');
  console.log('deleted-route tests passed');
}

/** AgentsHub over a fake runtime — reserved names 409 before any spawn happens. */
function fakeTerminals(createdOptions: CreateAgentOptions[]): TerminalRuntime {
  const create = (options: CreateAgentOptions): Promise<AgentInfo> => {
    createdOptions.push(options);
    return Promise.resolve(agent({
      agentId: `agent_fake_${createdOptions.length}`,
      title: options.title ?? 'agent',
      provider: options.provider ?? 'claude',
      cwd: options.cwd,
    }));
  };
  return {
    create,
    write: () => true, submit: () => true, resize: () => true, rename: () => true, kill: () => true, archive: () => true,
    snapshot: () => '', activity: () => null, list: () => agents,
    onData: () => {}, onExit: () => {}, onSession: () => {},
  };
}

async function withAgentsHub(
  exercise: (base: string, createdOptions: CreateAgentOptions[]) => Promise<void>,
): Promise<void> {
  const createdOptions: CreateAgentOptions[] = [];
  const agentHub = new AgentsHub(new Set(), fakeTerminals(createdOptions));
  const hubApp = express();
  hubApp.use(express.json());
  agentHub.registerRoutes(hubApp);
  const hubServer: Server = await new Promise((resolve) => {
    const listening = hubApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    await exercise(`http://127.0.0.1:${(hubServer.address() as { port: number }).port}`, createdOptions);
  } finally {
    hubServer.close();
  }
}

async function postAgent(base: string, body: unknown): Promise<{ status: number }> {
  const response = await fetch(`${base}/api/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status };
}

async function testReservedNamesRejected(): Promise<void> {
  await withAgentsHub(async (base, createdOptions) => {
    for (const reserved of ['chris', 'kimi', '#team', 'room_x']) {
      const { status } = await postAgent(base, { title: reserved, provider: 'kimi' });
      assert.equal(status, 409, `spawn titled ${reserved} is rejected`);
    }
    for (const reserved of ['chris', 'kimi']) {
      const renamed = await fetch(`${base}/api/agents/agent_1`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: reserved }),
      });
      assert.equal(renamed.status, 409, `renaming onto ${reserved} is rejected`);
    }
    assert.equal(createdOptions.length, 0, 'no spawn ever reached the runtime');
  });
}

async function testProviderValidation(): Promise<void> {
  await withAgentsHub(async (base, createdOptions) => {
    assert.equal((await postAgent(base, { title: 'kimi-9', provider: 'kimi' })).status, 201);
    assert.equal(createdOptions[0]?.provider, 'kimi', 'kimi passes validation through to the spawn');
    assert.equal((await postAgent(base, { title: 'bogus-1', provider: 'bogus' })).status, 400);
  });
}

try {
  await testMailboxRegisterRoute();
  await testThreadsLinkValidatesAgainstTheArchive();
  await testDeletedRoutesAreGone();
  await testReservedNamesRejected();
  await testProviderValidation();
  console.log('PASS');
} finally {
  server.close();
}
