/**
 * messagingV2 rooms glue tests (slice N3 — the exit condition, in-process):
 * boot provisioning (fleet + team + mission rooms), the human's #team post
 * fanning out to every live agent's PTY as `[nvk-room #team …]`, the R4
 * blocked-member proof (terminal failed{blocked-by-contact-policy}, no PTY
 * text, send still accepted), and launch-time provisioning. N4 deleted the
 * browser shim (translated history + live rebroadcast) — its tests went
 * with it; the trailing-window reader (readTrailingPage, now the user
 * routes' paging) stays covered. Real embedded stack (memory store), real
 * ObjectModel fixture, fake TerminalRuntime. Run with
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
import { readTrailingPage } from './index.js';

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

const journalPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-rooms-journal-')), 'journal.jsonl');
const glueLogs: string[] = [];
const handle = await startMessagingV2({
  objectModel: model,
  storePath: journalPath,
  terminals,
  humanToken: 'human-secret',
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
  const windowed = await readTrailingPage(aliceWriter, fleetThreadId ?? (() => { throw new Error('no fleet') })());
  assert.equal(windowed.length, 200, 'history is capped at the contract pageLimitMax');
  assert.equal(windowed.at(-1)?.body.text, 'seed 205', 'the NEWEST messages are served, not the oldest page');
  assert.ok(!windowed.some((entry) => entry.body.text === 'seed 1'), 'the oldest page is NOT what the browser gets');
  console.log('trailing-window history test passed');
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
