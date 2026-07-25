// PeopleHub (mission_mission-control-ux, ruling S3): durable-first join keyed
// by agentId, no name folding, external presence honest. Real ObjectModel over
// temp stores for the fold case; runtime list faked. Run with:
//   npx tsx src/backend/people/index.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentInfo } from '../terminal/manager.js';
import { ObjectModel, type AgentBlock } from '../objectModel/index.js';
import { PeopleHub } from './index.js';

const STAMP = '2026-07-23T09:00:00+10:00';

function agentBlock(overrides: Partial<AgentBlock> & { id: string; name: string }): AgentBlock {
  return {
    kind: 'agent', 'ts': STAMP, provider: 'kimi', status: 'live',
    refs: [{ kind: 'team', value: 'team_x' }, { kind: 'mission', value: 'mission_x' }],
    ...overrides,
  } as AgentBlock;
}

function runtimeInfo(overrides: Partial<AgentInfo> & { agentId: string; title: string }): AgentInfo {
  return {
    provider: 'claude', sessionId: 'sess-r', projectDir: '/tmp', cwd: '/tmp',
    status: 'running', createdAt: STAMP,
    ...overrides,
  } as AgentInfo;
}

function hubOver(durable: AgentBlock[], runtime: AgentInfo[]): PeopleHub {
  return new PeopleHub({ listAgents: () => durable }, () => runtime);
}

// --- external chief: durable live + sessionId + NO runtime entry -----------
{
  const chief = agentBlock({
    id: 'agent_chief', name: 'chief-kimi-4', status: 'live', sessionId: 'session_ext-1', updated: STAMP,
  });
  const { people } = hubOver([chief], []).listPeople();
  assert.equal(people.length, 1);
  const person = people[0];
  assert.equal(person.agentId, 'agent_chief');
  assert.equal(person.durableStatus, 'live');
  assert.equal(person.runtime, null, 'no PTY entry must stay null — honest external presence');
  assert.equal(person.sessionId, 'session_ext-1');
  assert.equal(person.missionId, 'mission_x');
  assert.equal(person.teamId, 'team_x');
}

// --- retired durable agent ---------------------------------------------------
{
  const retired = agentBlock({ id: 'agent_old', name: 'Worker Old', status: 'retired' });
  const { people } = hubOver([retired], []).listPeople();
  assert.equal(people[0].durableStatus, 'retired');
  assert.equal(people[0].runtime, null);
}

// --- duplicate display names stay DISTINCT; runtime attaches by agentId ------
{
  const first = agentBlock({ id: 'agent_dup-1', name: 'Manager Kimi Visibility', status: 'retired' });
  const second = agentBlock({ id: 'agent_dup-2', name: 'Manager Kimi Visibility', status: 'live', sessionId: 'session_dup-2' });
  const runtime = [runtimeInfo({ agentId: 'agent_dup-2', title: 'Manager Kimi Visibility', status: 'running' })];
  const { people } = hubOver([first, second], runtime).listPeople();
  assert.equal(people.length, 2, 'no name folding — two durable ids are two people');
  const firstPerson = people.find((person) => person.agentId === 'agent_dup-1');
  const secondPerson = people.find((person) => person.agentId === 'agent_dup-2');
  assert.equal(firstPerson?.runtime, null, 'presence must not leak onto the same-named other person');
  assert.deepEqual(secondPerson?.runtime, { status: 'running' });
}

// --- runtime-only row (pre-model PTY spawn) ----------------------------------
{
  const runtime = [runtimeInfo({ agentId: 'rt-77', title: 'perf-verify', provider: 'codex', status: 'exited', sessionId: 'sess-77' })];
  const { people } = hubOver([], runtime).listPeople();
  assert.equal(people.length, 1);
  assert.equal(people[0].agentId, 'rt-77');
  assert.equal(people[0].durableStatus, null, 'unknown to the object model — never invented');
  assert.deepEqual(people[0].runtime, { status: 'exited' });
  assert.equal(people[0].sessionId, 'sess-77');
}

// --- response carries asOf ----------------------------------------------------
{
  const response = hubOver([], []).listPeople();
  assert.equal(typeof response.asOf, 'string');
  assert.ok(response.asOf.length > 0);
}

// --- ObjectModel.listAgents folds amended records by id (last line wins) -----
{
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-people-'));
  try {
    const early = agentBlock({ id: 'agent_fold', name: 'Folder', status: 'spawning' });
    const late = agentBlock({ id: 'agent_fold', name: 'Folder', status: 'live', sessionId: 'session_late', updated: STAMP });
    writeFileSync(path.join(scratch, 'agents.jsonl'), `${JSON.stringify(early)}\n${JSON.stringify(late)}\n`);
    const model = new ObjectModel({ storesDir: scratch });
    const agents = model.listAgents();
    assert.equal(agents.length, 1, 'duplicate id folds to one record');
    assert.equal(agents[0].status, 'live', 'last line wins');
    const { people } = new PeopleHub(model, () => []).listPeople();
    assert.equal(people.length, 1);
    assert.equal(people[0].sessionId, 'session_late');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ---------- Archive read (ruling S1): the on-demand projection ---------------
   Joins stable room ids to durable mission status through thread blocks, and
   exposes archived records the frozen RoomStore.list() contract discards. */
{
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-archive-'));
  const roomsPath = path.join(scratch, 'rooms.jsonl');
  try {
    writeFileSync(path.join(scratch, 'missions.jsonl'), [
      '{"id":"mission_done","kind":"mission","ts":"2026-07-21T10:00:00+10:00","title":"Done mission","status":"done"}',
      '{"id":"mission_live","kind":"mission","ts":"2026-07-21T10:00:00+10:00","title":"Live mission","status":"doing"}',
    ].map((line) => `${line}\n`).join(''));
    writeFileSync(path.join(scratch, 'threads.jsonl'), [
      '{"id":"thread_1","kind":"thread","ts":"2026-07-21T10:10:00+10:00","roomId":"room_closedmission","refs":[{"kind":"mission","value":"mission_done"}]}',
      '{"id":"thread_2","kind":"thread","ts":"2026-07-21T10:10:00+10:00","roomId":"room_livemission","refs":[{"kind":"mission","value":"mission_live"}]}',
    ].map((line) => `${line}\n`).join(''));
    const retiredOne = agentBlock({ id: 'agent_ret-1', name: 'Same Name', status: 'retired' });
    const retiredTwo = agentBlock({ id: 'agent_ret-2', name: 'Same Name', status: 'retired' });
    writeFileSync(path.join(scratch, 'agents.jsonl'), `${JSON.stringify(retiredOne)}\n${JSON.stringify(retiredTwo)}\n`);
    writeFileSync(roomsPath, [
      '{"roomId":"room_dead","name":"Legacy tab room","members":["chris"],"createdBy":"chris","createdAt":"2026-07-17T00:00:00Z","archived":true}',
      '{"roomId":"room_closedmission","name":"closed mission room","members":["chris"],"createdBy":"chris","createdAt":"2026-07-18T00:00:00Z","archived":false}',
      '{"roomId":"room_livemission","name":"live mission room","members":["chris"],"createdBy":"chris","createdAt":"2026-07-19T00:00:00Z","archived":false}',
      '{"roomId":"room_plain","name":"plain open room","members":["chris"],"createdBy":"chris","createdAt":"2026-07-20T00:00:00Z","archived":false}',
    ].map((line) => `${line}\n`).join(''));
    const model = new ObjectModel({ storesDir: scratch });
    const peopleHub = new PeopleHub(model, () => [], roomsPath);
    const { archived } = peopleHub.listArchive();

    // S1 default view: the people read carries the archived room-lane ids.
    assert.deepEqual(peopleHub.listPeople().archivedLaneIds.sort(), ['room_closedmission', 'room_dead'],
      'archived + closed-mission room ids ride the default people read');

    const byId = new Map(archived.map((lane) => [lane.id, lane]));
    assert.equal(byId.get('room_dead')?.reason, 'room-archived', 'explicitly archived room surfaces on demand');
    assert.equal(byId.get('room_closedmission')?.reason, 'mission-closed', 'room whose thread-linked mission is done');
    assert.equal(byId.get('room_closedmission')?.missionId, 'mission_done', 'mission provenance carried');
    assert.ok(!byId.has('room_livemission'), 'open-mission room is NOT archived');
    assert.ok(!byId.has('room_plain'), 'plain open room is NOT archived');
    const people = archived.filter((lane) => lane.kind === 'person');
    assert.equal(people.length, 2, 'two retired agents sharing a display name stay two distinct rows');
    assert.deepEqual(people.map((lane) => lane.id).sort(), ['agent_ret-1', 'agent_ret-2'], 'person rows keyed by agentId, never dm:<name>');
    assert.ok(people.every((lane) => lane.conversationId === 'dm:Same Name'), 'transport pointer stays the mailbox name');
    assert.ok(people.every((lane) => lane.reason === 'person-retired'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ---------- Tiered liveness (mission_visual-truth, Ruling 3) -----------------
   Ordering law: live > external-verified > unverified > exited > retired/failed.
   Unverified is NEVER green; retired/failed never promote; no evidence never
   becomes green. The journal's createdAt (NOT ts) is the external-activity
   evidence, bounded by EXTERNAL_ACTIVITY_TTL_MS. */
{
  const NOW_MS = Date.parse('2026-07-23T12:00:00.000Z');
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-liveness-'));
  const journalPath = path.join(scratch, 'messages.jsonl');
  try {
    const acceptance = (id: string, senderId: string, createdAt: string, extra = {}) => JSON.stringify({
      'op': 'acceptance',
      thread: { id: 'thread_dm', kind: 'thread', schemaVersion: 1, createdAt, threadKind: 'direct' },
      message: {
        id, kind: 'message', schemaVersion: 1, createdAt, threadId: 'thread_dm',
        senderId, clientMessageId: `cm-${id}`, sequence: 1, priority: 'normal',
        body: { text: 'activity' }, ...extra,
      },
    });
    writeFileSync(journalPath, [
      acceptance('m1', 'person_agent-ext', '2026-07-23T11:55:00.000Z'),
      acceptance('m2', 'person_agent-stale', '2026-07-23T10:00:00.000Z'),
      acceptance('m3', 'person_agent-ret', '2026-07-23T11:59:00.000Z'),
      acceptance('m4', 'person_agent-ts', 'not-a-date', { 'ts': '2026-07-23T11:59:00.000Z' }),
      'torn line not json',
    ].map((line) => `${line}\n`).join(''));
    const opts = { journalPath, now: () => NOW_MS };
    const ghost = agentBlock({ id: 'agent_ghost', name: 'Worker Messages Builder', status: 'live' });
    const verified = agentBlock({ id: 'agent_ext', name: 'chief-kimi-7', status: 'live', sessionId: 'session_ext-6' });
    const stale = agentBlock({ id: 'agent_stale', name: 'Stale Bot', status: 'live' });
    const retired = agentBlock({ id: 'agent_ret', name: 'Retired Bot', status: 'retired' });
    const split = agentBlock({ id: 'agent_split', name: 'Manager Kimi Messages', status: 'live' });
    const tsTrap = agentBlock({ id: 'agent_ts', name: 'Ts Trap', status: 'live' });
    const running = agentBlock({ id: 'agent_run', name: 'Worker Kimi Visual', status: 'live' });
    const runtime = [
      runtimeInfo({ agentId: 'agent_split', title: 'Manager Kimi Messages', status: 'exited' }),
      runtimeInfo({ agentId: 'agent_run', title: 'Worker Kimi Visual', status: 'running' }),
    ];
    const { people } = new PeopleHub({ listAgents: () => [ghost, verified, stale, retired, split, tsTrap, running] }, () => runtime, undefined, opts).listPeople();
    const tier = new Map(people.map((person) => [person.agentId, person.liveness]));
    assert.equal(tier.get('agent_run'), 'live', 'running PTY is live');
    assert.equal(tier.get('agent_ext'), 'external-verified', 'fresh journal activity verifies an external session');
    assert.equal(tier.get('agent_ghost'), 'unverified', 'durable live + no runtime + no evidence → unverified, NEVER green (the ghost class)');
    assert.equal(tier.get('agent_stale'), 'unverified', 'activity older than the TTL no longer verifies');
    assert.equal(tier.get('agent_ts'), 'unverified', 'the ts field is NOT evidence — createdAt or nothing');
    assert.equal(tier.get('agent_split'), 'exited', 'runtime exited wins over stale durable live (split-brain cured)');
    assert.equal(tier.get('agent_ret'), 'retired', 'retired never promotes, even with fresh activity');
    // The ordering law as data: a dead agent never reads healthier than a live one.
    const rank = { 'live': 5, 'external-verified': 4, 'unverified': 3, 'exited': 2, 'retired': 1, 'failed': 1 } as const;
    assert.ok(rank[tier.get('agent_ghost')!] < rank[tier.get('agent_ext')!], 'ghost < verified external');
    assert.ok(rank[tier.get('agent_ret')!] < rank[tier.get('agent_ghost')!], 'retired < unverified');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- no journal wired: external sessions derive unverified, never guessed ----
{
  const external = agentBlock({ id: 'agent_x', name: 'chief-kimi-7', status: 'live', sessionId: 'session_x' });
  const { people } = hubOver([external], []).listPeople();
  assert.equal(people[0].liveness, 'unverified', 'without evidence the honest tier is unverified');
}

console.log('people hub: all assertions passed');
