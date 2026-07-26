/**
 * messagingV2 server-owned human route tests (slice N4, D-N4-3): the
 * browser's send/read surface through the capability AS the human principal
 * (no Bearer — the server is the trust boundary). Send to a live agent, to
 * '#team', and to room labels/ids; error grammar (400/404+roster/503);
 * threads list; trailing-window messages. Real embedded
 * stack (JSONL journal in tmp), real ObjectModel fixture, fake
 * TerminalRuntime for PTY effects. Run with
 * `npx tsx src/backend/messagingV2/userRoutes/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { createSystemClock } from '../../../../packages/messaging/adapters/clock-system.js';
import { createMemoryStore } from '../../../../packages/messaging/adapters/store-memory.js';
import { createEmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { ObjectModel } from '../../objectModel/index.js';
import { startMessagingV2 } from '../index.js';
import type { MessagingV2Handle } from '../index.js';
import { createNovakaiAuthority, personIdForAgentId } from '../authority/index.js';
import { createNovakaiMembership } from '../membership/index.js';
import { registerMessagingV2UserRoutes } from './index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-userroutes-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'),
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }) + '\n');
  return scratch;
}

function agentInfo(agentId: string, title: string, provider: AgentInfo['provider'] = 'claude'): AgentInfo {
  return {
    agentId, title, provider, sessionId: 'session',
    projectDir: 'project', cwd: '/tmp/project', status: 'running', createdAt: new Date().toISOString(),
  };
}

class FakeTerminalRuntime implements TerminalRuntime {
  readonly submissions: SubmitJob[] = [];
  constructor(private readonly agents: AgentInfo[]) {}
  create(): Promise<AgentInfo> { return Promise.reject(new Error('unused')); }
  write(): boolean { return true; }
  submit(submission: SubmitJob): boolean { this.submissions.push(submission); return true; }
  activity(): null { return null; }
  resize(): boolean { return true; }
  rename(): boolean { return true; }
  kill(): boolean { return true; }
  archive(): boolean { return true; }
  snapshot(): string { return ''; }
  list(): AgentInfo[] { return this.agents; }
  onData(): void {}
  onExit(): void {}
  onSession(): void {}
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const teamId = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const aliceId = model.createAgent({ name: 'chief-kimi', provider: 'kimi', teamId, missionId: 'mission_alpha' });
const bobId = model.createAgent({ name: 'worker-b', provider: 'claude', teamId, missionId: 'mission_alpha' });
// F9: durable but OFFLINE — no live terminal anywhere.
const carolId = model.createAgent({ name: 'worker-c', provider: 'claude', teamId, missionId: 'mission_alpha' });
const terminals = new FakeTerminalRuntime([
  agentInfo(aliceId, 'chief-kimi', 'kimi'),
  agentInfo(bobId, 'worker-b'),
]);

const journalPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-user-journal-')), 'journal.jsonl');
const handle = await startMessagingV2({
  objectModel: model, storePath: journalPath, terminals, humanToken: 'human-secret', 'log': () => {},
});

const application = express();
application.use(express.json());
registerMessagingV2UserRoutes(application, { getHandle: () => handle, terminals, objectModel: model });
const server: Server = await new Promise((resolve) => {
  const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function userSend(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/messaging/v2/user/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

async function userGet(route: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

// --- human → agent DM: delivered to the recipient's lane as chris --------------

const direct = await userSend({ 'to': 'worker-b', body: 'dm from the browser' });
assert.equal(direct.status, 201, JSON.stringify(direct.json));
const toBob = terminals.submissions.at(-1);
assert.equal(toBob?.agentId, bobId);
assert.equal(
  toBob?.text,
  `[nvk-msg from chris id ${String(direct.json['messageId'])}] dm from the browser`,
  'the human display name renders as chris',
);
console.log('user send DM test passed');

// --- human → rooms: fleet, label, and id forms -------------------------------------

const fleet = await userSend({ 'to': '#team', body: 'fleet from the browser' });
assert.equal(fleet.status, 201);
assert.ok(
  terminals.submissions.some((submission) =>
    submission.agentId === aliceId
    && submission.text === `[nvk-room #team from chris id ${String(fleet.json['messageId'])}] fleet from the browser`),
  "alice's lane received the fleet post",
);
const byLabel = await userSend({ 'to': '#Messaging Crew', body: 'team room post' });
assert.equal(byLabel.status, 201, 'a room LABEL resolves to its thread');
const byId = await userSend({ 'to': '#mission_alpha', body: 'mission room post' });
assert.equal(byId.status, 201, 'a room id resolves to its thread');
console.log('user send room tests passed');

// --- error grammar -----------------------------------------------------------------------

const empty = await userSend({ 'to': 'worker-b', body: '' });
assert.equal(empty.status, 400);
const missing = await userSend({ 'to': 'nobody-here', body: 'x' });
assert.equal(missing.status, 404);
assert.deepEqual(missing.json['roster'], ['chief-kimi', 'worker-b'], 'the 404 carries the live roster hint');
const bogusRoom = await userSend({ 'to': '#bogus', body: 'x' });
assert.equal(bogusRoom.status, 404);
const roomInterrupt = await userSend({ 'to': '#team', body: 'x', interrupt: true });
assert.equal(roomInterrupt.status, 400, 'interrupt to a room stays rejected');
const agentInterrupt = await userSend({ 'to': 'worker-b', body: 'urgent dm', interrupt: true });
assert.equal(agentInterrupt.status, 201, 'the human holds priority.override — urgent DMs are legal');
assert.deepEqual(terminals.submissions.at(-1)?.leadIn, { data: '\x1b', settleMs: 400 });
console.log('error grammar tests passed');

// --- F9: offline/durable recipients resolve — the capability decides deliverability ---

const offline = await userSend({ 'to': 'worker-c', body: 'you are offline but durable' });
assert.equal(offline.status, 201, 'an exited-but-durable agent name resolves (NOT 404)');
assert.ok(
  !terminals.submissions.some((submission) => submission.text.includes('you are offline but durable')),
  'nothing types into a lane that does not exist',
);
const humanSession = handle.lanes?.humanSession();
assert.ok(humanSession);
const offlineDelivery = await humanSession?.getDelivery({ messageId: offline.json['messageId'] });
if (offlineDelivery?.kind !== 'ok') throw new Error('unreachable');
assert.equal(offlineDelivery?.value.deliveries[0]?.state, 'pending', 'delivery pends honestly for the offline agent');
const unknown = await userSend({ 'to': 'worker-ghost', body: 'x' });
assert.equal(unknown.status, 404, 'a truly unknown name still 404s with the roster hint');
assert.ok(Array.isArray(unknown.json['roster']));
console.log('offline recipient resolution tests passed');

// --- reads: threads, trailing-window messages --------------------------------------

const threads = await userGet('/api/messaging/v2/user/threads');
assert.equal(threads.status, 200);
const threadList = threads.json['threads'] as Array<Record<string, unknown>>;
assert.ok(threadList.some((thread) => thread['threadKind'] === 'team'), 'the fleet room is listed');
assert.ok(threadList.some((thread) => thread['threadKind'] === 'direct'), 'the DM thread is listed');

const fleetThreadId = String(fleet.json['threadId']);
const messages = await userGet(`/api/messaging/v2/user/messages?threadId=${fleetThreadId}`);
assert.equal(messages.status, 200);
const bodies = (messages.json['messages'] as Array<{ body: { text: string } }>).map((message) => message.body.text);
assert.ok(bodies.includes('fleet from the browser'), 'the trailing window serves the fleet post');
const missingThread = await userGet('/api/messaging/v2/user/messages');
assert.equal(missingThread.status, 400);
const unknownThread = await userGet('/api/messaging/v2/user/messages?threadId=thread_ghost');
assert.equal(unknownThread.status, 404, 'an unknown thread is a 404, never a 500');
console.log('user read tests passed');

// --- hotfix: a dead human session answers 503 (transient), never a bare 500 ----
// Observed in production: the 1h session lapsed, every /user route returned
// NotAuthenticated, and statusForError/readFailure had no case for it → 500.
// An auth lapse while the session re-mints is transient 'capability down'.

const deadClock = createSystemClock();
const deadEmbedded = createEmbeddedMessaging({
  clock: deadClock,
  store: createMemoryStore(deadClock),
  authority: createNovakaiAuthority(model, deadClock, {
    sessionTtlMs: 60,
    humans: [{ token: 'human-secret', personId: 'person_user-chris' as never, roles: ['Human'] }],
  }),
  membership: createNovakaiMembership(model, deadClock),
});
await deadEmbedded.start();
const deadAuth = await deadEmbedded.authenticate({ token: 'human-secret' });
if (deadAuth.kind !== 'authenticated') throw new Error('unreachable');
const deadSession = deadAuth.session;
await new Promise((resolve) => setTimeout(resolve, 120)); // lazy expiry past the 60 ms TTL
const deadHandle: MessagingV2Handle = {
  embedded: deadEmbedded,
  lanes: { humanSession: () => deadSession } as never,
  rooms: null,
  close: () => deadEmbedded.close(),
};
const deadApp = express();
deadApp.use(express.json());
registerMessagingV2UserRoutes(deadApp, { getHandle: () => deadHandle, terminals, objectModel: model });
const deadServer: Server = await new Promise((resolve) => {
  const listening = deadApp.listen(0, '127.0.0.1', () => resolve(listening));
});
const deadBase = `http://127.0.0.1:${(deadServer.address() as { port: number }).port}`;

const deadThreads = await fetch(`${deadBase}/api/messaging/v2/user/threads`);
assert.equal(deadThreads.status, 503, 'threads on a dead session is 503, never 500');
const deadSend = await fetch(`${deadBase}/api/messaging/v2/user/send`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ 'to': 'worker-b', body: 'still here?' }),
});
assert.equal(deadSend.status, 503, 'send on a dead session is 503, never 500');
const deadMessages = await fetch(`${deadBase}/api/messaging/v2/user/messages?threadId=${fleetThreadId}`);
assert.equal(deadMessages.status, 503, 'the readTrailingPage throw path is 503, never 500');

await deadEmbedded.close();
deadServer.close();
console.log('dead-session 503 tests passed');

// --- A-R-N4-1: the owner's oversight.read — agent↔agent lanes are visible ------
// PR #72 ruling: the owner MUST see agent↔agent DM lanes. The human
// principal carries the grant (host policy in the composition), so the
// user-threads route serves lanes the human is NOT a party to.

const aliceAuth = await handle.embedded.authenticate({ token: aliceId });
if (aliceAuth.kind !== 'authenticated') throw new Error('unreachable');
const agentLane = await aliceAuth.session.sendMessage({
  address: `person:${personIdForAgentId(bobId)}`,
  body: { text: 'agent-to-agent oversight target' },
  priority: 'normal', clientMessageId: 'rn41-lane-1',
});
assert.equal(agentLane.kind, 'ok', 'the agent↔agent lane commits');
if (agentLane.kind !== 'ok') throw new Error('unreachable');

const humanPrincipal = handle.lanes?.humanSession()?.principal;
assert.ok(humanPrincipal?.grants.includes('oversight.read'), 'the human principal authenticates WITH oversight.read');

const oversightThreads = await userGet('/api/messaging/v2/user/threads');
assert.equal(oversightThreads.status, 200);
const oversightList = oversightThreads.json['threads'] as Array<Record<string, unknown>>;
assert.ok(
  oversightList.some((thread) => thread['id'] === agentLane.value.threadId),
  'the user-threads route includes an agent↔agent direct lane (A-R-N4-1)',
);
const humanSends = await userSend({ 'to': 'worker-b', body: 'owner dm still works' });
assert.equal(humanSends.status, 201, 'oversight is additive — the human lane still sends');
console.log('oversight.read tests passed');

await handle.close();
server.close();
rmSync(scratch, { recursive: true, force: true });
console.log('messagingV2 user route tests passed');
