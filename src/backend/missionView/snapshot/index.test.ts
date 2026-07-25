// Mission Room V1 snapshot tests (pure derive, fabricated fixtures). Run with
// `npx tsx src/backend/missionView/snapshot/index.test.ts`.
import assert from 'node:assert/strict';
import { deriveSnapshot } from './index.js';
import type { MissionFacts } from './index.js';
import { resolveLinkage } from '../linkage/index.js';
import type { MissionLinkage } from '../linkage/index.js';
import type { PacketFile, RawRecord, RegistryEntry, RoomRecord, StoreName } from '../sources/index.js';
import type { MessageEnvelope } from '../../messaging/types.js';
import type { MissionSnapshot } from '../../../shared/missionView/schema.js';
import { agentEntry, envelopeLine, issueLine, logLine, missionLine, okrLine, requestLine, roomLine, taskLine } from '../tests/fixtures.js';

const MISSION_REFS = ',"refs":[{"kind":"project","value":"proj_a"},'
  + '{"kind":"exp","value":"EXP-1"},'
  + '{"kind":"doc","value":".novakai/work/mission_a/brief.md","label":"Mission Contract"},'
  + '{"kind":"doc","value":"https://example/pr/42","label":"PR #42"},'
  + '{"kind":"objective","value":"okr_a"}]';

function record(store: StoreName, line: number, json: string): RawRecord {
  return { store, path: `/fake/${store}.jsonl`, line, block: JSON.parse(json) as Record<string, unknown> };
}

function storesOf(partials: Partial<Record<StoreName, RawRecord[]>>): Record<StoreName, RawRecord[]> {
  return {
    'missions': [], 'tasks': [], 'okrs': [], 'requests': [], 'issues': [], 'captains-log': [],
    'projects': [], 'teams': [], 'agents': [], 'artifacts': [], 'threads': [], ...partials,
  };
}

function linked(missionId: string, stores: Record<StoreName, RawRecord[]>): MissionLinkage {
  const result = resolveLinkage(missionId, stores);
  assert.equal(result.status, 'resolved');
  return (result as { linkage: MissionLinkage }).linkage;
}

function makeFacts(linkage: MissionLinkage, overrides: Partial<MissionFacts> = {}): MissionFacts {
  return {
    missionId: String(linkage.mission.block.id),
    linkage,
    stores: storesOf({}),
    journal: [],
    journalPath: '/fake/messages.jsonl',
    registry: [],
    registryPath: '/fake/agents.json',
    registryObservedAt: null,
    rooms: [],
    roomsPath: '/fake/rooms.jsonl',
    packet: [],
    readProblems: [],
    asOf: '2026-07-21T13:00:00.000Z',
    ...overrides,
  };
}

function envelope(envelopeId: string, body: string): MessageEnvelope {
  // The shape readJournalEnvelopes produces from an acceptance line (N5) —
  // built directly: envelopeLine is the on-disk form, this is the folded form.
  return {
    id: envelopeId, from: 'person_agent-agent-a', 'to': 'thread_fixture',
    delivery: 'normal', body, threadId: 'thread_fixture',
    createdAt: '2026-07-21T11:30:00+10:00', status: 'delivered',
  };
}

function packetFile(name: string): PacketFile {
  return { name, path: `/fake/work/mission_a/${name}`, observedModifiedAt: '2026-07-21T12:05:00.000Z' };
}

function roomRecord(roomId: string, line: number, json: string): RoomRecord {
  return { roomId, path: '/fake/rooms.jsonl', line, block: JSON.parse(json) as Record<string, unknown> };
}

function fullStores(): Record<StoreName, RawRecord[]> {
  return storesOf({
    'missions': [record('missions', 11, missionLine('mission_a', MISSION_REFS))],
    'tasks': [record('tasks', 10, taskLine('task_a', 'mission_a'))],
    'captains-log': [record('captains-log', 56, logLine('log_a', 'mission_a'))],
    'issues': [record('issues', 7, issueLine('issue_a', 'task_a'))],
    'okrs': [record('okrs', 12, okrLine('okr_a', 'O10 truth integrity'))],
    'requests': [record('requests', 2, requestLine('req_a', 'mission_a', 'pending'))],
  });
}

function fullFacts(): MissionFacts {
  return makeFacts(linked('mission_a', fullStores()), {
    journal: [envelope('msg_1', 'mission_a in body'), envelope('msg_2', 'mission_a again'), envelope('msg_3', 'unrelated')],
    registry: [agentEntry('agent_live', false, 'proj_a') as unknown as RegistryEntry],
    registryObservedAt: '2026-07-21T12:30:00.000Z',
    packet: [packetFile('brief.md'), packetFile('plan.md')],
  });
}

function testPulse(snapshot: MissionSnapshot): void {
  assert.equal(snapshot.pulse.outcome.value, 'Mission mission_a', 'outcome falls back to title (M6)');
  assert.equal(snapshot.pulse.phase.value, 'step-6-closed', 'phase from stage');
  assert.equal(snapshot.pulse.health.value, 'attention', 'attention items present → attention');
  assert.equal(snapshot.pulse.lastUpdate.value, '2026-07-21T12:00:00+10:00');
  assert.equal(snapshot.pulse.nextCheckpoint.value, null, 'closed mission → null; UI renders the sourced closed line');
  assert.equal(snapshot.pulse.needsChris.value, true);
  assert.equal(snapshot.pulse.needsChris.sourceRefs[0].recordId, 'req_a');
}

function testMissionAndObjective(snapshot: MissionSnapshot): void {
  assert.equal(snapshot.mission.owner.value, 'chief-kimi', 'owner stays a raw sourced field');
  assert.deepEqual(snapshot.assignments, [], 'owner is never promoted into assignments (S4)');
  assert.deepEqual(snapshot.declaredRoles, [], 'no declared roles on the fixture mission');
  assert.deepEqual(snapshot.members, [], 'no durable agent refs this mission');
  assert.equal(snapshot.objective?.value, 'O10 truth integrity');
  assert.equal(snapshot.objective?.sourceRefs[0].store, 'okrs');
  assert.deepEqual(snapshot.presences, [], 'no mission-linked presence exists');
  assert.deepEqual(snapshot.currentActivity, []);
}

function testArtifacts(snapshot: MissionSnapshot): void {
  assert.deepEqual(snapshot.artifacts.map((entry) => entry.label), ['Mission Contract', 'PR #42']);
  assert.equal(snapshot.artifacts[0].observedModifiedAt, '2026-07-21T12:05:00.000Z', 'packet mtime is observation time (L2)');
  assert.equal(snapshot.artifacts[0].producedAt, null);
  assert.equal(snapshot.artifacts[1].observedModifiedAt, null, 'PR is label + URL only; no fs observation');
}

function testAttention(snapshot: MissionSnapshot): void {
  const idSet = new Set(snapshot.attention.map((entry) => entry.id));
  assert.ok(idSet.has('attention:no-assignments'));
  assert.ok(idSet.has('attention:no-presences'));
  assert.ok(idSet.has('attention:no-current-activity'));
  assert.ok(idSet.has('attention:unresolvable-ref:EXP-1'));
  assert.ok(idSet.has('attention:evidence-candidate:plan.md'), 'packet neighbor is a labeled candidate, not an artifact');
  assert.ok(!idSet.has('attention:evidence-candidate:brief.md'), 'explicitly ref\'d contract is an artifact');
  assert.ok(idSet.has('attention:presence-candidate:agent_live'), 'project-only registry entry is a candidate');
}

function testCommunication(snapshot: MissionSnapshot): void {
  const item = snapshot.attention.find((entry) => entry.id === 'attention:no-thread-ref');
  assert.equal(item?.label, 'no explicit thread/room ref exists for this mission', 'the primary gap (M3)');
  assert.ok(item?.detail.includes('0 room record(s) read from /fake/rooms.jsonl'), 'the room store was actually read and states what was verified (C1)');
  assert.ok(item?.detail.includes('2 journal envelope(s)'), 'mention count is diagnostic detail only');
  assert.ok(!snapshot.timeline.some((entry) => entry.summary.includes('in body')), 'never promoted into the timeline');
}

function testMalformedJournalBodyIsRecoverable(): void {
  const malformed = JSON.parse('{"id":"msg_bad","from":"agent-a","to":"agent-b","delivery":"normal",'
    + '"createdAt":"2026-07-21T11:30:00+10:00","status":"delivered"}') as MessageEnvelope;
  const snapshot = deriveSnapshot(makeFacts(linked('mission_a', fullStores()), {
    journal: [envelope('msg_good', 'mission_a in body'), malformed],
  }));
  const item = snapshot.attention.find((entry) => entry.id === 'attention:no-thread-ref');
  assert.ok(item?.detail.includes('1 journal envelope(s)'), 'only string bodies contribute to diagnostic mention counts');
}

// C1: a room WITH an explicit typed mission ref resolves into the timeline;
// rooms without one stay out, and the communication gap item disappears.
function testRoomsResolve(): void {
  const linkedRoom = roomRecord('room_x', 4, roomLine('room_x', 'mission room', ',"refs":[{"kind":"mission","value":"mission_a"}]'));
  const plainRoom = roomRecord('room_y', 5, roomLine('room_y', 'other room'));
  const snapshot = deriveSnapshot(makeFacts(linked('mission_a', fullStores()), { rooms: [linkedRoom, plainRoom] }));
  const resolved = snapshot.timeline.find((entry) => entry.id === 'room_x');
  assert.equal(resolved?.kind, 'room', 'explicit mission ref on the room record resolves (C1)');
  assert.deepEqual(resolved?.refPath, ['mission_a', 'room_x']);
  assert.ok(!snapshot.timeline.some((entry) => entry.id === 'room_y'), 'a room without a mission ref stays out');
  assert.ok(!snapshot.attention.some((entry) => entry.id === 'attention:no-thread-ref'), 'linked room → communication is linked, not a gap');
}

// C1: with rooms read but none linked, the item states exactly what was verified.
function testCommunicationStatesVerifiedRooms(): void {
  const rooms = [roomRecord('room_y', 5, roomLine('room_y', 'other')), roomRecord('room_z', 6, roomLine('room_z', 'third'))];
  const snapshot = deriveSnapshot(makeFacts(linked('mission_a', fullStores()), { rooms }));
  const item = snapshot.attention.find((entry) => entry.id === 'attention:no-thread-ref');
  assert.ok(item?.detail.includes('2 room record(s) read from /fake/rooms.jsonl, none carrying an explicit ref'), 'verified fact, never an unread claim');
  assert.ok(item?.sourceRefs.some((sourceRef) => sourceRef.store === 'rooms'), 'the room store is cited');
}

// C2/R1: threadId equals the mission id — still NOT a binding (Thread
// namespace), and no typed binding exists on canonical AgentInfo, so
// presences/currentActivity are unconditionally empty with attention items.
function testPresenceInferenceRemoved(): void {
  const threadTwin = { ...agentEntry('agent_thread'), threadId: 'mission_a' } as unknown as RegistryEntry;
  const snapshot = deriveSnapshot(makeFacts(linked('mission_a', fullStores()), { registry: [threadTwin] }));
  assert.deepEqual(snapshot.presences, [], 'threadId matching the mission id is NOT a mission binding (C2)');
  assert.deepEqual(snapshot.currentActivity, [], 'availability never becomes current work (C2)');
  assert.ok(snapshot.attention.some((entry) => entry.id === 'attention:no-presences'), 'the presence gap stays visible');
  assert.ok(snapshot.attention.some((entry) => entry.id === 'attention:no-current-activity'), 'the activity gap stays visible');
}

// C3: health derives from attention + issues, so it cites beyond the mission row.
function testHealthProvenance(): void {
  const snapshot = deriveSnapshot(fullFacts());
  assert.equal(snapshot.pulse.health.value, 'attention');
  const cited = new Set(snapshot.pulse.health.sourceRefs.map((sourceRef) => sourceRef.store));
  assert.ok(cited.has('missions'), 'the mission row is cited');
  assert.ok(cited.size > 1, 'health cites its actual contributing inputs, not the mission row alone (C3)');
  assert.ok(
    cited.has('registry') || cited.has('journal') || cited.has('packet') || cited.has('rooms'),
    'at least one contributing source beyond the stores is cited',
  );
}

// R2: a validation issue carries provenance, and health folds it in — the
// tasks store is cited when the missing-ts issue contributes to 'attention'.
function testHealthCitesIssueSource(): void {
  const noTs = '{"id":"task_nots","kind":"task","title":"No ts","status":"done","refs":[{"kind":"mission","value":"mission_a"}]}';
  const stores = storesOf({ ...fullStores(), 'tasks': [record('tasks', 10, noTs)] });
  const snapshot = deriveSnapshot(makeFacts(linked('mission_a', stores)));
  const issue = snapshot.issues.find((entry) => entry.message.includes("missing required field 'ts'"));
  assert.ok(issue, 'the missing-ts validation issue exists');
  assert.equal(issue?.sourceRefs[0].store, 'tasks', 'the issue cites the tasks store and line');
  assert.equal(issue?.sourceRefs[0].line, 10);
  assert.ok(
    snapshot.pulse.health.sourceRefs.some((sourceRef) => sourceRef.store === 'tasks'),
    'health cites the tasks store when the issue contributes (R2)',
  );
}

function testTimeline(snapshot: MissionSnapshot): void {
  assert.deepEqual(
    snapshot.timeline.map((entry) => entry.id),
    ['task_a', 'log_a', 'issue_a', 'mission_a'],
    'chronological by timestamp, labeled chronological (M4)',
  );
  const hopEntry = snapshot.timeline.find((entry) => entry.id === 'issue_a');
  assert.equal(hopEntry?.kind, 'issue');
  assert.deepEqual(hopEntry?.refPath, ['mission_a', 'task_a', 'issue_a']);
}

function testInvalidHealth(): void {
  const noTitle = '{"id":"mission_bad","kind":"mission","ts":"2026-07-21T10:00:00+10:00","status":"done"}';
  const snapshot = deriveSnapshot(makeFacts(linked('mission_bad', storesOf({ missions: [record('missions', 3, noTitle)] }))));
  assert.equal(snapshot.pulse.health.value, 'unknown', 'invalid mission record → unknown, never rendered clean');
  assert.ok(snapshot.issues.some((entry) => entry.message.includes('no non-empty string title')));
}

function testZeroRefs(): void {
  const snapshot = deriveSnapshot(makeFacts(linked('mission_solo', storesOf({ missions: [record('missions', 1, missionLine('mission_solo'))] }))));
  assert.deepEqual(snapshot.artifacts, []);
  assert.equal(snapshot.objective, null);
  assert.deepEqual(snapshot.timeline.map((entry) => entry.id), ['mission_solo']);
  assert.equal(snapshot.pulse.needsChris.value, false);
  assert.ok(!snapshot.issues.some((entry) => entry.message.includes('dangling')), 'zero refs dangle nothing');
}

function testReadProblemsSurface(): void {
  const facts = makeFacts(linked('mission_a', fullStores()), { readProblems: [{ message: 'store file missing: okrs.jsonl', sourceRefs: [{ store: 'okrs', path: '/fake/okrs.jsonl' }] }] });
  const snapshot = deriveSnapshot(facts);
  assert.ok(snapshot.issues.some((entry) => entry.message.includes('store file missing: okrs.jsonl')), 'read problems render as visible issues');
  assert.equal(snapshot.pulse.health.value, 'attention');
}

function main(): void {
  const snapshot = deriveSnapshot(fullFacts());
  testPulse(snapshot);
  testMissionAndObjective(snapshot);
  testArtifacts(snapshot);
  testAttention(snapshot);
  testCommunication(snapshot);
  testMalformedJournalBodyIsRecoverable();
  testTimeline(snapshot);
  testRoomsResolve();
  testCommunicationStatesVerifiedRooms();
  testPresenceInferenceRemoved();
  testHealthProvenance();
  testHealthCitesIssueSource();
  testInvalidHealth();
  testZeroRefs();
  testReadProblemsSurface();
  console.log('PASS');
}

main();
