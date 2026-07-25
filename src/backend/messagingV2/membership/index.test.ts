/**
 * messagingV2 membership adapter tests (slice N1): ObjectModel-backed
 * MembershipSource. Real ObjectModel instances against fixture stores in
 * os.tmpdir() — no mocks of ObjectModel. The adapter is constructed directly
 * (its own seam); the messaging capability is crossed only via seam headers
 * (RoomRef/outcome types, failure vocabulary) and the public contract.
 * Run with `npx tsx src/backend/messagingV2/membership/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PersonId, Timestamp } from '../../../../packages/messaging/public/contract/index.js';
import type { ClockIds } from '../../../../packages/messaging/seams/clock.js';
import type { RoomRef } from '../../../../packages/messaging/seams/membership.js';
import { ObjectModel } from '../../objectModel/index.js';
import { readStoreDir, replaceLine } from '../../stores/store.mjs';
import { personIdForAgentId } from '../authority/index.js';
import { createNovakaiMembership } from './index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

// A test-local clock: the adapter under test never mints ids, only reads time.
const clock: ClockIds = {
  'now': () => new Date().toISOString() as Timestamp,
  newId: (() => {
    throw new Error('newId is unused by the messagingV2 membership adapter');
  }) as ClockIds['newId'],
};

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-membership-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'), [
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }),
    JSON.stringify({ id: 'mission_beta', kind: 'mission', 'ts': STAMP, title: 'Beta', owner: 'chief' }),
  ].join('\n') + '\n');
  return scratch;
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const membership = createNovakaiMembership(model, clock);

const teamId = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const otherTeamId = model.createTeam({ name: 'Beta Crew', missionId: 'mission_beta' });
const aliceId = model.createAgent({ name: 'chief-kimi', provider: 'kimi', teamId, missionId: 'mission_alpha' });
const bobId = model.createAgent({ name: 'worker-bob', provider: 'claude', teamId, missionId: 'mission_alpha' });
const carolId = model.createAgent({ name: 'worker-carol', provider: 'codex', teamId: otherTeamId, missionId: 'mission_beta' });
const goneId = model.createAgent({ name: 'worker-gone', provider: 'claude', teamId, missionId: 'mission_alpha' });

// --- mission room resolution ----------------------------------------------------

const missionRoom: RoomRef = { authority: 'mission', externalId: 'mission_alpha' };
const resolved = await membership.resolveMembers(missionRoom);
assert.equal(resolved.kind, 'resolved');
if (resolved.kind !== 'resolved') throw new Error('unreachable');
assert.deepEqual(
  [...resolved.members].sort(),
  [personIdForAgentId(aliceId), personIdForAgentId(bobId), personIdForAgentId(goneId)].sort(),
  'roster derives from Agent refs (spawning agents are receivable)',
);
assert.equal(resolved.evidence.authority, 'mission');
assert.match(resolved.evidence.revision, /^[0-9a-f]{64}$/, 'revision is sha256 hex of the sorted roster');
assert.equal(typeof resolved.evidence.resolvedAt, 'string');
console.log('mission resolve tests passed');

// Revision evidence tracks membership (R8/§3.2.3): retire a member, the
// roster shrinks AND the revision changes; unknown members never linger.
const record = readStoreDir(scratch).files['agents.jsonl'].records
  .find((entry: { block: { id?: string; updated?: unknown } }) => entry.block.id === goneId);
assert.ok(record, 'gone agent exists');
// `updated` must move STRICTLY forward — same-ms flips collide without the
// floor+1 guard (the N1 CI-flake class).
const gonePreviousMs = Date.parse(typeof record.block.updated === 'string' ? record.block.updated : '') || 0;
replaceLine(scratch, 'agents.jsonl', goneId,
  JSON.stringify({ ...record.block, status: 'retired', updated: new Date(Math.max(Date.now(), gonePreviousMs + 1)).toISOString() }),
  { expectedRaw: record.raw });

const afterRetire = await membership.resolveMembers(missionRoom);
assert.equal(afterRetire.kind, 'resolved');
if (afterRetire.kind !== 'resolved') throw new Error('unreachable');
assert.deepEqual(
  [...afterRetire.members].sort(),
  [personIdForAgentId(aliceId), personIdForAgentId(bobId)].sort(),
  'retired agents cannot receive — excluded from the roster',
);
assert.notEqual(afterRetire.evidence.revision, resolved.evidence.revision, 'membership change is a revision change');
console.log('revision/roster freshness tests passed');

// Unknown rooms are this seam's own vocabulary (§3.1), never a throw.
const unknownMission = await membership.resolveMembers({ authority: 'mission', externalId: 'mission_ghost' });
assert.equal(unknownMission.kind, 'unknown');
if (unknownMission.kind === 'unknown') {
  assert.equal(unknownMission.error.name, 'UnknownRoom');
  assert.equal(unknownMission.error.authority, 'mission');
  assert.equal(unknownMission.error.externalId, 'mission_ghost');
}
const unknownAuthority = await membership.resolveMembers({ authority: 'gossip', externalId: 'mission_alpha' });
assert.equal(unknownAuthority.kind, 'unknown', 'an authority string outside mission/team is unknown');
console.log('unknown room tests passed');

// --- team room resolution (refs, never a member list on the team block) ---------

const teamResolved = await membership.resolveMembers({ authority: 'team', externalId: teamId });
assert.equal(teamResolved.kind, 'resolved');
if (teamResolved.kind !== 'resolved') throw new Error('unreachable');
assert.deepEqual(
  [...teamResolved.members].sort(),
  [personIdForAgentId(aliceId), personIdForAgentId(bobId)].sort(),
  'team roster derives from Agent team refs (goneId now retired)',
);
const unknownTeam = await membership.resolveMembers({ authority: 'team', externalId: 'team_ghost' });
assert.equal(unknownTeam.kind, 'unknown');
console.log('team resolve tests passed');

// --- isMember: read-time authorization only (§3.2.4) ------------------------------

const aliceIsMember = await membership.isMember(missionRoom, personIdForAgentId(aliceId));
assert.deepEqual(aliceIsMember, { kind: 'known', member: true });
const carolIsMember = await membership.isMember(missionRoom, personIdForAgentId(carolId));
assert.deepEqual(carolIsMember, { kind: 'known', member: false }, 'beta agent is not on mission_alpha');
const goneIsMember = await membership.isMember(missionRoom, personIdForAgentId(goneId));
assert.deepEqual(goneIsMember, { kind: 'known', member: false }, 'retired agent is not a member');
const unknownIsMember = await membership.isMember({ authority: 'mission', externalId: 'mission_ghost' }, personIdForAgentId(aliceId));
assert.equal(unknownIsMember.kind, 'unknown');
console.log('isMember tests passed');

// --- roster dedupe (N1 audit finding 9): ObjectModel.missionAgents does not fold
// by id — a duplicated agent line must never double-receive a room send. --------
const aliceRecord = readStoreDir(scratch).files['agents.jsonl'].records
  .find((entry: { block: { id?: string } }) => entry.block.id === aliceId);
assert.ok(aliceRecord, 'alice exists');
appendFileSync(path.join(scratch, 'agents.jsonl'), aliceRecord.raw + '\n'); // the double-mint class
const deduped = await membership.resolveMembers(missionRoom);
assert.equal(deduped.kind, 'resolved');
if (deduped.kind !== 'resolved') throw new Error('unreachable');
assert.equal(
  deduped.members.filter((member) => member === personIdForAgentId(aliceId)).length,
  1,
  'a duplicated agent line yields the Person exactly once (finding 9)',
);
console.log('roster dedupe test passed');

// --- dependency failure → typed unavailable (§3.3), never a throw -----------------

rmSync(scratch, { recursive: true, force: true });
const unavailable = await membership.resolveMembers(missionRoom);
assert.equal(unavailable.kind, 'unavailable');
if (unavailable.kind === 'unavailable') {
  assert.equal(unavailable.error.name, 'DependencyUnavailable');
  assert.equal(unavailable.error.fields['dependency'], 'membership');
  assert.equal(unavailable.error.retryable, true);
}
const unavailableIsMember = await membership.isMember(missionRoom, 'person_x' as PersonId);
assert.equal(unavailableIsMember.kind, 'unavailable');
console.log('dependency failure tests passed');

// --- D-N3-1: the fleet authority + the human principal in EVERY roster ---------

{
  const humanScratch = scratchStores();
  const humanModel = new ObjectModel({ storesDir: humanScratch });
  const crewId = humanModel.createTeam({ name: 'Fleet Crew', missionId: 'mission_alpha' });
  const betaCrewId = humanModel.createTeam({ name: 'Beta Crew', missionId: 'mission_beta' });
  const alphaAgent = humanModel.createAgent({ name: 'worker-a', provider: 'claude', teamId: crewId, missionId: 'mission_alpha' });
  const betaAgent = humanModel.createAgent({ name: 'worker-b', provider: 'kimi', teamId: betaCrewId, missionId: 'mission_beta' });
  const human = 'person_user-chris' as PersonId;
  const fleetMembership = createNovakaiMembership(humanModel, clock, human);

  const fleetRoom: RoomRef = { authority: 'fleet', externalId: 'team' };
  const fleet = await fleetMembership.resolveMembers(fleetRoom);
  assert.equal(fleet.kind, 'resolved');
  if (fleet.kind !== 'resolved') throw new Error('unreachable');
  assert.deepEqual(
    [...fleet.members].sort(),
    [personIdForAgentId(alphaAgent), personIdForAgentId(betaAgent), human].sort(),
    'fleet roster = every active durable agent + the human, across missions',
  );
  const wrongId = await fleetMembership.resolveMembers({ authority: 'fleet', externalId: 'everyone' });
  assert.equal(wrongId.kind, 'unknown', 'only the constant fleet externalId resolves');
  console.log('fleet roster tests passed');

  const alphaRoom = await fleetMembership.resolveMembers({ authority: 'mission', externalId: 'mission_alpha' });
  if (alphaRoom.kind !== 'resolved') throw new Error('unreachable');
  assert.ok(alphaRoom.members.includes(human), 'the human rides the mission roster (owner host policy)');
  const teamRoom = await fleetMembership.resolveMembers({ authority: 'team', externalId: crewId });
  if (teamRoom.kind !== 'resolved') throw new Error('unreachable');
  assert.ok(teamRoom.members.includes(human), 'the human rides the team roster');
  const humanMember = await fleetMembership.isMember(fleetRoom, human);
  assert.deepEqual(humanMember, { kind: 'known', member: true }, 'isMember admits the human');
  console.log('human-in-every-roster tests passed');

  // Revision evidence covers the human inclusion: adding the human to the
  // served roster changes the hash; a roster change changes it again.
  const bareMembership = createNovakaiMembership(humanModel, clock);
  const bare = await bareMembership.resolveMembers(fleetRoom);
  if (bare.kind !== 'resolved' || fleet.kind !== 'resolved') throw new Error('unreachable');
  assert.notEqual(bare.evidence.revision, fleet.evidence.revision, 'the human inclusion is revision-visible');
  assert.ok(!bare.members.includes(human), 'no humanToken, no human in the roster');
  const doomedAgent = humanModel.createAgent({ name: 'worker-doomed', provider: 'codex', teamId: crewId, missionId: 'mission_alpha' });
  humanModel.markAgentFailed(doomedAgent, 'test');
  const before = (await fleetMembership.resolveMembers(fleetRoom)) as typeof fleet;
  if (before.kind !== 'resolved') throw new Error('unreachable');
  const thirdAgent = humanModel.createAgent({ name: 'worker-c', provider: 'claude', teamId: crewId, missionId: 'mission_alpha' });
  const after = await fleetMembership.resolveMembers(fleetRoom);
  if (after.kind !== 'resolved') throw new Error('unreachable');
  assert.notEqual(before.evidence.revision, after.evidence.revision, 'a roster change is a revision change');
  assert.ok(after.members.includes(personIdForAgentId(thirdAgent)));
  rmSync(humanScratch, { recursive: true, force: true });
  console.log('fleet revision tests passed');
}

console.log('messagingV2 membership adapter tests passed');
