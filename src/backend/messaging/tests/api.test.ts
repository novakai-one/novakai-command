// MessagingHub REST + broadcast tests over a real express app — the SURVIVING
// surface (user sends, history reads, identity, rooms, AgentsHub spawns).
// N2 deleted the agent-originated POST /api/messages route, handleSend, and
// the spawn briefing; their tests went with them. Run with
// `npx tsx src/backend/messaging/tests/api.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { MessagingHub, TEAM_CHANNEL } from '../index.js';
import type { MessageEnvelope } from '../index.js';
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
const writes: Array<{ agentId: string; data: string }> = [];
const broadcasts: Array<{ event: string; payload: MessageEnvelope }> = [];
const recordWrite = (agentId: string, data: string): boolean => {
  writes.push({ agentId, data });
  return true;
};

const messagingHub = new MessagingHub(
  { list: () => agents, write: recordWrite },
  (event, payload) => broadcasts.push({ event, payload: payload as MessageEnvelope }),
  {
    storePath: join(mkdtempSync(join(tmpdir(), 'nvk-api-')), 'messages.jsonl'),
    timings: { interruptSettleMs: 0, submitDelayMs: 0 },
    // Fake sessionIds — the real transcript confirmer would poll for files
    // that never exist. null disables confirmation; sends note it honestly.
    effectConfirmer: null,
  },
);

const application = express();
application.use(express.json());
messagingHub.registerRoutes(application);
const server: Server = await new Promise((resolve) => {
  const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
});
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function postAsUser(body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/api/user/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function getMessages(query: string): Promise<MessageEnvelope[]> {
  const response = await fetch(`${baseUrl}/api/messages${query}`);
  return (await response.json()).messages;
}

async function testHistoryQueryFilters(): Promise<void> {
  await postAsUser({ 'to': 'codex-1', body: 'done', threadId: 'thread-a' });
  await postAsUser({ 'to': TEAM_CHANNEL, body: 'status: green' });
  assert.equal((await getMessages('')).length, 2);
  const channel = await getMessages(`?withAgent=${encodeURIComponent(TEAM_CHANNEL)}`);
  assert.equal(channel.length, 1, 'channel read via withAgent=#team');
  assert.equal(channel[0]?.body, 'status: green');
  assert.equal((await getMessages('?threadId=thread-a'))[0]?.threadId, 'thread-a');
  assert.equal((await getMessages('?limit=1')).length, 1);
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

async function testRegisteredUserIdentityOwnsBrowserSends(): Promise<void> {
  const identityResponse = await fetch(`${baseUrl}/api/identity`);
  assert.equal(identityResponse.status, 200);
  assert.deepEqual(await identityResponse.json(), {
    identity: {
      id: 'user:chris',
      displayName: 'Chris',
      memberName: 'chris',
      role: 'owner',
      permissions: ['messages:send', 'rooms:send'],
    },
  });

  const direct = await postAsUser({ from: 'spoofed-agent', 'to': 'codex-1', body: 'browser-authored' });
  assert.equal(direct.status, 201);
  assert.equal(direct.json.envelope.from, 'chris', 'server identity overrides client sender claims');
}

async function testOwnerIdentitySendsToAnyMissionRoom(): Promise<void> {
  const roomResponse = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Agents only', members: ['claude-1', 'codex-1'], from: 'claude-1' }),
  });
  const roomId = (await roomResponse.json()).room.roomId as string;
  const roomSend = await postAsUser({ 'to': roomId, body: 'owner can address every mission room' });
  assert.equal(roomSend.status, 201, 'owner identity has permission to send to any mission room');
  assert.equal(roomSend.json.envelope.from, 'chris');
}

async function testOwnerTeamPostReachesEveryLiveAgent(): Promise<void> {
  writes.length = 0;
  const teamPost = await postAsUser({ 'to': TEAM_CHANNEL, body: 'Hello team, this is live chat.' });
  assert.equal(teamPost.status, 201);
  assert.deepEqual(
    writes.filter((entry) => entry.data !== '\r').map((entry) => entry.agentId),
    ['agent_1', 'agent_2'],
    'Chris team chat is pushed to every live agent instead of waiting for terminal polling',
  );
  for (const write of writes.filter((entry) => entry.data !== '\r')) {
    assert.match(write.data, /^\[nvk-msg from chris id msg_[^\]]+\] Hello team, this is live chat\.$/);
  }
}

async function testAgentsCanReplyToUserInboxIsGone(): Promise<void> {
  // N2: the agent-originated route is deleted — it now answers 404 (agent
  // sends authenticate through the v2 routes instead).
  const reply = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'codex-1', 'to': 'chris', body: 'x' }),
  });
  assert.equal(reply.status, 404, 'POST /api/messages is gone (N2)');
}

async function testOpenBrowserTabsUpgradeToRegisteredIdentity(): Promise<void> {
  const roomResponse = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Legacy tab room',
      members: ['codex-1'],
      from: 'chris',
    }),
  });
  assert.equal(roomResponse.status, 201);
  const room = (await roomResponse.json()).room;
  assert.equal(room.createdBy, 'chris');
  assert.deepEqual(room.members, ['codex-1', 'chris']);
}

try {
  await testHistoryQueryFilters();
  await testReservedNamesRejected();
  await testProviderValidation();
  await testRegisteredUserIdentityOwnsBrowserSends();
  await testOwnerIdentitySendsToAnyMissionRoom();
  await testOwnerTeamPostReachesEveryLiveAgent();
  await testAgentsCanReplyToUserInboxIsGone();
  await testOpenBrowserTabsUpgradeToRegisteredIdentity();
  console.log('PASS');
} finally {
  server.close();
}
