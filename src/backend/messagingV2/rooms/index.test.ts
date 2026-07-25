/**
 * messagingV2 rooms glue tests (slice N3 — the exit condition, in-process):
 * boot provisioning (fleet + team + mission rooms), the human's #team post
 * fanning out to every live agent's PTY as `[nvk-room #team …]`, the R4
 * blocked-member proof (terminal failed{blocked-by-contact-policy}, no PTY
 * text, send still accepted), the browser shim (translated history + live
 * broadcast), and launch-time provisioning. Real embedded stack (memory
 * store), real ObjectModel fixture, fake TerminalRuntime. Run with
 * `npx tsx src/backend/messagingV2/rooms/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import type { Delivery } from '../../../../packages/messaging/public/contract/index.js';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { ObjectModel } from '../../objectModel/index.js';
import { personIdForAgentId } from '../authority/index.js';
import { startMessagingV2 } from '../index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-rooms-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'), [
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }),
    JSON.stringify({ id: 'mission_beta', kind: 'mission', 'ts': STAMP, title: 'Beta', owner: 'chief' }),
  ].join('\n') + '\n');
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
  constructor(private agents: AgentInfo[]) {}
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
  restore(info: AgentInfo): void {
    this.agents = [...this.agents.filter((agent) => agent.agentId !== info.agentId), info];
  }
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const alphaTeam = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const betaTeam = model.createTeam({ name: 'Beta Crew', missionId: 'mission_beta' });
const aliceId = model.createAgent({ name: 'chief-kimi', provider: 'kimi', teamId: alphaTeam, missionId: 'mission_alpha' });
const bobId = model.createAgent({ name: 'worker-b', provider: 'claude', teamId: alphaTeam, missionId: 'mission_alpha' });
// carol shares NO team/mission ref with the crew — the R4 blocked member.
const carolId = model.createAgent({ name: 'worker-c', provider: 'claude', teamId: betaTeam, missionId: 'mission_beta' });
const alicePerson = personIdForAgentId(aliceId);
const bobPerson = personIdForAgentId(bobId);
const aliceInfo = agentInfo(aliceId, 'chief-kimi', 'kimi');
const bobInfo = agentInfo(bobId, 'worker-b');
const carolInfo = agentInfo(carolId, 'worker-c');
const terminals = new FakeTerminalRuntime([aliceInfo, bobInfo, carolInfo]);
const broadcasts: Array<{ event: string; payload: unknown }> = [];

const journalPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-rooms-journal-')), 'journal.jsonl');
const glueLogs: string[] = [];
const handle = await startMessagingV2({
  objectModel: model,
  storePath: journalPath,
  terminals,
  humanToken: 'human-secret',
  broadcast: (event, payload) => broadcasts.push({ event, payload }),
  'log': (line) => glueLogs.push(line),
});
const rooms = handle.rooms;
assert.ok(rooms, 'the rooms glue booted');

async function authenticate(token: string): Promise<MessagingSession> {
  const auth = await handle.embedded.authenticate({ token });
  if (auth.kind !== 'authenticated') throw new Error('unreachable');
  return auth.session;
}

function laneText(agentId: string): string[] {
  return terminals.submissions.filter((submission) => submission.agentId === agentId)
    .map((submission) => submission.text);
}

// --- D-N3-2: boot provisioning ---------------------------------------------------

const fleetThreadId = rooms.fleetThreadId();
assert.ok(fleetThreadId, 'the fleet room is provisioned at boot');
assert.equal(rooms.labelFor(fleetThreadId ?? ''), '#team');
const teamThreadId = rooms.threadIdFor('team', alphaTeam);
const missionThreadId = rooms.threadIdFor('mission', 'mission_alpha');
assert.ok(teamThreadId, 'one room per teams.jsonl team');
assert.equal(rooms.labelFor(teamThreadId ?? ''), '#Messaging Crew', 'label falls to the team name');
assert.ok(missionThreadId, 'one room per missions.jsonl mission');
assert.equal(rooms.labelFor(missionThreadId ?? ''), '#Alpha', 'label falls to the mission title');
await rooms.ensureAllRooms();
assert.equal(rooms.fleetThreadId(), fleetThreadId, 'get-or-create is idempotent');
console.log('boot provisioning tests passed');

// --- D-N3-3/5: the human posts #team → every live agent's PTY (the exit condition) ---

const posted = await rooms.post('hello fleet');
assert.equal(posted.from, 'chris', 'translated envelope stamps the human');
assert.equal(posted.to, '#team');
assert.equal(posted.status, 'delivered');
assert.equal(posted.body, 'hello fleet');
for (const agentId of [aliceId, bobId, carolId]) {
  assert.ok(
    laneText(agentId).some((text) => text === `[nvk-room #team from chris id ${posted.id}] hello fleet`),
    `${agentId} received the fleet post typed as [nvk-room #team …]`,
  );
}
console.log('human #team fan-out test passed');

// --- sender-in-recipients: the CORE's truth (decideSend.ts — NO sender exclusion) ---

const alice = await authenticate(aliceId);
const alicePost = await alice.sendMessage({
  address: `thread:${fleetThreadId}`, body: { text: 'alice to fleet' },
  priority: 'normal', clientMessageId: 'n3-rooms-1',
});
assert.equal(alicePost.kind, 'ok');
assert.ok(
  laneText(aliceId).some((text) => text.includes('[nvk-room #team from chief-kimi') && text.includes('alice to fleet')),
  'CORE TRUTH: the sender is a room recipient too — alice receives her own post (flagged, not dropped)',
);
console.log('sender-in-recipients documentation test passed');

// --- R4: a member whose policy blocks the sender — terminal failed, no PTY text ----

const carol = await authenticate(carolId);
const carolPost = await carol.sendMessage({
  address: `thread:${fleetThreadId}`, body: { text: 'carol to fleet' },
  priority: 'normal', clientMessageId: 'n3-rooms-2',
});
assert.equal(carolPost.kind, 'ok', 'BlockedByContactPolicy NEVER rejects a room send');
if (carolPost.kind !== 'ok') throw new Error('unreachable');
const deliveries = await carol.getDelivery({ messageId: carolPost.value.messageId });
if (deliveries.kind !== 'ok') throw new Error('unreachable');
for (const blocked of [alicePerson, bobPerson]) {
  const record: Delivery | undefined = deliveries.value.deliveries.find((entry) => entry.recipientId === blocked);
  assert.equal(record?.state, 'failed', `${blocked} terminally failed`);
  assert.equal(record?.stateReason, 'blocked-by-contact-policy', 'R4 state reason');
}
assert.ok(!laneText(aliceId).some((text) => text.includes('carol to fleet')), 'blocked member: NO PTY text for alice');
assert.ok(!laneText(bobId).some((text) => text.includes('carol to fleet')), 'blocked member: NO PTY text for bob');
assert.ok(laneText(carolId).some((text) => text.includes('carol to fleet')), 'the sender self-lane is never blocked');
console.log('R4 blocked-member proof passed');

// --- D-N3-4 READ shim: translated history in the old envelope shape -----------------

const history = await rooms.history();
assert.equal(history.length, 3, 'fleet history: human post + alice post + carol post');
assert.ok(history.every((entry) => entry.to === '#team' && entry.status === 'delivered' && entry.delivery === 'normal'));
assert.deepEqual(history.map((entry) => entry.from), ['chris', 'chief-kimi', 'worker-c'], 'display names translate');
console.log('shim history test passed');

// --- D-N3-4 LIVE shim: a committed room message triggers the broadcast --------------

await handle.embedded.pumpEvents(); // drive the bus tail deterministically
const liveFrame = broadcasts.find((entry) =>
  entry.event === 'message-envelope'
  && (entry.payload as { id?: string }).id === posted.id);
assert.ok(liveFrame, 'the human post committed → message-envelope broadcast fired');
assert.deepEqual(liveFrame?.payload, posted, 'the live frame is the same translated envelope');
console.log('shim live broadcast test passed');

// --- D-N3-2: launch-time provisioning for a team with no room yet -------------------

const gammaTeam = model.createTeam({ name: 'Gamma Crew', missionId: 'mission_alpha' });
const dormId = model.createAgent({ name: 'worker-d', provider: 'claude', teamId: gammaTeam, missionId: 'mission_alpha' });
rooms.handleAgentLaunched(agentInfo(dormId, 'worker-d'));
await new Promise((resolve) => setTimeout(resolve, 50));
assert.ok(rooms.threadIdFor('team', gammaTeam), 'launch provisions the new team room');
assert.equal(rooms.labelFor(rooms.threadIdFor('team', gammaTeam) ?? ''), '#Gamma Crew');
console.log('launch-time provisioning test passed');

// --- FIX 4: room history serves the TRAILING window (newest page), not the oldest ---

{
  const aliceWriter = await authenticate(aliceId);
  for (let count = 1; count <= 205; count += 1) {
    const seeded = await aliceWriter.sendMessage({
      address: `thread:${fleetThreadId}`, body: { text: `seed ${count}` },
      priority: 'normal', clientMessageId: `n3-seed-${count}`,
    });
    assert.equal(seeded.kind, 'ok');
  }
  const windowed = await rooms.history();
  assert.equal(windowed.length, 200, 'history is capped at the contract pageLimitMax');
  assert.equal(windowed.at(-1)?.body, 'seed 205', 'the NEWEST messages are served, not the oldest page');
  assert.ok(!windowed.some((entry) => entry.body === 'seed 1'), 'the oldest page is NOT what the browser gets');
  console.log('trailing-window history test passed');
}

// --- FIX 2: only FLEET commits rebroadcast — team/mission commits never leak --------

{
  await handle.embedded.pumpEvents(); // drain the seed commits first
  broadcasts.length = 0;
  const aliceRoom = await authenticate(aliceId);
  const teamPost = await aliceRoom.sendMessage({
    address: `thread:${teamThreadId}`, body: { text: 'team room only' },
    priority: 'normal', clientMessageId: 'n3-fix2-1',
  });
  assert.equal(teamPost.kind, 'ok');
  await handle.embedded.pumpEvents();
  assert.equal(broadcasts.length, 0, 'a team-room commit produces NO message-envelope broadcast');
  const fleetPost2 = await aliceRoom.sendMessage({
    address: `thread:${fleetThreadId}`, body: { text: 'fleet again' },
    priority: 'normal', clientMessageId: 'n3-fix2-2',
  });
  assert.equal(fleetPost2.kind, 'ok');
  await handle.embedded.pumpEvents();
  const fleetFrames = broadcasts.filter((entry) => entry.event === 'message-envelope');
  assert.equal(fleetFrames.length, 1, 'a fleet commit produces exactly one broadcast');
  assert.equal((fleetFrames[0]?.payload as { to?: string }).to, '#team');
  console.log('fleet-only rebroadcast test passed');
}

// --- FIX 1: the real client shape — GET /api/messages?withAgent=%23team --------------
// (route level, with a pre-seeded OLD-journal archive line that must NOT merge, D1)

{
  const { MessagingHub } = await import('../../messaging/index.js');
  const { TEAM_CHANNEL } = await import('../../messaging/types.js');
  const express = (await import('express')).default;
  const archivePath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-archive-')), 'messages.jsonl');
  const archiveEnvelope = {
    id: 'msg_archive_1', from: 'claude-1', 'to': TEAM_CHANNEL, delivery: 'normal',
    body: 'pre-N3 archive line', createdAt: STAMP, status: 'delivered',
  };
  writeFileSync(archivePath, JSON.stringify(archiveEnvelope) + '\n');
  const shimHub = new MessagingHub(
    { list: () => terminals.list(), write: () => true },
    () => {},
    { storePath: archivePath, teamLane: () => rooms, effectConfirmer: null },
  );
  const shimApp = express();
  shimApp.use(express.json());
  shimHub.registerRoutes(shimApp);
  const shimServer = await new Promise<import('node:http').Server>((resolve) => {
    const listening = shimApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (shimServer.address() as { port: number }).port;
  const shimPost = await rooms.post('shim real-client read');
  const realClient = await fetch(`http://127.0.0.1:${port}/api/messages?withAgent=%23team`);
  assert.equal(realClient.status, 200);
  const served = (await realClient.json()) as { messages: Array<Record<string, unknown>> };
  assert.ok(
    served.messages.some((entry) => entry['id'] === shimPost.id && entry['to'] === '#team' && entry['status'] === 'delivered'),
    'a capability-era fleet message is served in the translated old-envelope form',
  );
  assert.ok(
    !served.messages.some((entry) => entry['body'] === 'pre-N3 archive line'),
    'the old-journal archive is NOT merged (D1)',
  );
  shimServer.close();
  console.log('real-client-shape shim test passed');
}

// --- FIX 3: boot with pre-existing fleet history → ZERO replay rebroadcasts ----------

await handle.close();

{
  const rebootBroadcasts: Array<{ event: string; payload: unknown }> = [];
  const rebootLogs: string[] = [];
  const reboot = await startMessagingV2({
    objectModel: model,
    storePath: journalPath, // the SAME journal — fleet history pre-exists
    terminals,
    humanToken: 'human-secret',
    broadcast: (event, payload) => rebootBroadcasts.push({ event, payload }),
    'log': (line) => rebootLogs.push(line),
  });
  await reboot.embedded.pumpEvents();
  assert.equal(
    rebootBroadcasts.filter((entry) => entry.event === 'message-envelope').length,
    0,
    'boot must NOT replay fleet history into the browser (the subscription is cursor-seeded)',
  );
  const rebootRooms = reboot.rooms;
  assert.ok(rebootRooms);
  const fresh = await rebootRooms.post('post-reboot commit');
  await reboot.embedded.pumpEvents();
  const freshFrames = rebootBroadcasts.filter((entry) => entry.event === 'message-envelope');
  assert.equal(freshFrames.length, 1, 'only NEW commits broadcast after boot');
  assert.equal((freshFrames[0]?.payload as { id?: string }).id, fresh.id);

  // An ended frame is logged LOUDLY (never a silent subscription death).
  const rebootAuthority = reboot.embedded.authority as unknown as { invalidateSession(sessionId: string): void };
  const humanSession = reboot.lanes?.humanSession();
  assert.ok(humanSession);
  rebootAuthority.invalidateSession(humanSession.principal.sessionId);
  assert.equal(await humanSession.revalidate(), 'ended');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    rebootLogs.some((line) => /ended/i.test(line)),
    'an ended frame (auth-lost) is logged loudly',
  );
  await reboot.close();
  console.log('replay-seed + ended-logging tests passed');
}

// --- self-minted human token (N3 live-verification fix): no humanToken dep →
// the human principal STILL exists and #team posts work (production 503'd when
// the env var was unset — the app is the human session's only consumer, so an
// ops-required env var was ceremony). ------------------------------------------

{
  const noTokenLogs: string[] = [];
  const noToken = await startMessagingV2({
    objectModel: model,
    storePath: path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-notoken-journal-')), 'journal.jsonl'),
    terminals: new FakeTerminalRuntime([]),
    'log': (line) => noTokenLogs.push(line),
  });
  assert.ok(
    noTokenLogs.some((line) => line.includes('principals=5')),
    `self-minted human counts as a principal (4 active agents + human), got: ${JSON.stringify(noTokenLogs)}`,
  );
  const noTokenRooms = noToken.rooms;
  assert.ok(noTokenRooms, 'the rooms glue boots without a configured humanToken');
  const posted = await noTokenRooms.post('no-env-token post');
  assert.equal(posted.to, '#team', 'the human #team lane works with the self-minted token');
  await noToken.close();
  console.log('self-minted human token test passed');
}

rmSync(scratch, { recursive: true, force: true });
console.log('messagingV2 rooms glue tests passed');
