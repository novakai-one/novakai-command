// MessagingHub REST + broadcast tests over a real express app — the SURVIVING
// surface (user sends, history reads, identity, the free-room shim, AgentsHub
// spawns). N2 deleted the agent-originated POST /api/messages route and the
// spawn briefing; N3 deleted the router's channel/room arms and the
// from-trusting room routes — #team sends/reads now delegate to the injected
// capability TeamLane (faked here; the real fan-out is covered by the
// messagingV2 rooms tests). Run with
// `npx tsx src/backend/messaging/tests/api.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { MessagingHub, TEAM_CHANNEL } from '../index.js';
import type { MessageEnvelope, TeamLane, TeamLaneEnvelope } from '../index.js';
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

/** The fake capability lane: records #team posts in the translated shape.
 * laneMode 'unavailable' simulates a capability DependencyUnavailable. */
let laneMode: 'ok' | 'unavailable' = 'ok';
const teamPosts: TeamLaneEnvelope[] = [];
const fakeLane: TeamLane = {
  post(body: string): Promise<TeamLaneEnvelope> {
    if (laneMode === 'unavailable') {
      const failure = new Error('authority is unavailable');
      failure.name = 'DependencyUnavailable';
      return Promise.reject(failure);
    }
    const envelope: TeamLaneEnvelope = {
      id: `message_fake_${teamPosts.length + 1}`,
      from: 'chris',
      'to': TEAM_CHANNEL,
      body,
      createdAt: new Date().toISOString(),
      status: 'delivered',
      delivery: 'normal',
    };
    teamPosts.push(envelope);
    return Promise.resolve(envelope);
  },
  history(): Promise<TeamLaneEnvelope[]> {
    return Promise.resolve([...teamPosts]);
  },
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
    teamLane: () => fakeLane,
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
  assert.equal((await getMessages('')).length, 1, 'the #team post lives in the capability, not the old store');
  const channel = await getMessages(`?withAgent=${encodeURIComponent(TEAM_CHANNEL)}`);
  assert.equal(channel.length, 1, 'channel read delegates to the capability lane');
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

async function testFreeRoomSendsAreGone(): Promise<void> {
  // N3 (D-N3-6): the router's room arms are deleted — a free-room send now
  // 404s as an unknown recipient. Free rooms are archive-only (reads and
  // browser creation survive via the shim) until N4.
  const roomResponse = await fetch(`${baseUrl}/api/user/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Agents only', members: ['claude-1', 'codex-1'] }),
  });
  assert.equal(roomResponse.status, 201, 'browser room creation survives via the shim');
  const roomId = (await roomResponse.json()).room.roomId as string;
  const roomSend = await postAsUser({ 'to': roomId, body: 'free rooms no longer route' });
  assert.equal(roomSend.status, 404, 'routeRoom is deleted — free-room sends die in N3');
}

async function testTeamPostDelegatesToTheCapabilityLane(): Promise<void> {
  writes.length = 0;
  broadcasts.length = 0;
  const before = teamPosts.length;
  const teamPost = await postAsUser({ 'to': TEAM_CHANNEL, body: 'Hello team, this is live chat.' });
  assert.equal(teamPost.status, 201);
  assert.equal(teamPosts.length, before + 1, 'the post went through the capability lane, not SendApi');
  assert.equal(teamPost.json.envelope.to, TEAM_CHANNEL);
  assert.equal(teamPost.json.envelope.from, 'chris', 'server-stamped sender in the translated envelope');
  assert.equal(writes.length, 0, 'the old hub types nothing — capability delivery owns the fan-out');
  assert.equal(broadcasts.length, 0, 'the old store saw no #team append (D1: no new writes)');
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
  const roomResponse = await fetch(`${baseUrl}/api/user/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Legacy tab room',
      members: ['codex-1'],
    }),
  });
  assert.equal(roomResponse.status, 201);
  const room = (await roomResponse.json()).room;
  assert.equal(room.createdBy, 'chris');
  assert.deepEqual(room.members, ['codex-1', 'chris']);
}

async function testTeamChannelErrorHonesty(): Promise<void> {
  // FIX 7a: an empty #team body is a 400 (client error), never a 502.
  const empty = await postAsUser({ 'to': TEAM_CHANNEL, body: '' });
  assert.equal(empty.status, 400, 'empty #team body → 400');
  laneMode = 'unavailable';
  try {
    const unavailable = await postAsUser({ 'to': TEAM_CHANNEL, body: 'during an outage' });
    assert.equal(unavailable.status, 503, 'capability DependencyUnavailable → 503');
  } finally {
    laneMode = 'ok';
  }
}

try {
  await testHistoryQueryFilters();
  await testReservedNamesRejected();
  await testProviderValidation();
  await testRegisteredUserIdentityOwnsBrowserSends();
  await testFreeRoomSendsAreGone();
  await testTeamPostDelegatesToTheCapabilityLane();
  await testTeamChannelErrorHonesty();
  await testAgentsCanReplyToUserInboxIsGone();
  await testOpenBrowserTabsUpgradeToRegisteredIdentity();
  console.log('PASS');
} finally {
  server.close();
}
