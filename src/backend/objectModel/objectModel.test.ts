// Object-model write interface (plan v2 §1.2/§1.4): domain verbs over the
// store engine — creation, session attach idempotency + Presence-history
// rotation, explicit failure records, task transitions, the thread link.
// Run with `npx tsx src/backend/objectModel/objectModel.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObjectModel, ObjectModelError } from './index.js';
import { readStoreDir } from '../stores/store.mjs';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-objectmodel-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'), [
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }),
    JSON.stringify({ id: 'mission_beta', kind: 'mission', 'ts': STAMP, title: 'Beta', owner: 'chief' }),
  ].join('\n') + '\n');
  writeFileSync(path.join(scratch, 'projects.jsonl'),
    JSON.stringify({ id: 'proj_alpha', kind: 'project', 'ts': STAMP, title: 'Alpha', status: 'active', path: '~/Programming/alpha' }) + '\n');
  writeFileSync(path.join(scratch, 'okrs.jsonl'), [
    JSON.stringify({ id: 'okr_alpha', kind: 'objective', 'ts': STAMP, title: 'Own the quarter', horizon: 'now' }),
    JSON.stringify({ id: 'kr_alpha', kind: 'kr', 'ts': STAMP, objective: 'okr_alpha', body: 'Ship 3 things' }),
  ].join('\n') + '\n');
  return scratch;
}

function blockById(scratch: string, storeFile: string, id: string): Record<string, unknown> {
  const record = readStoreDir(scratch).files[storeFile].records.find((entry) => entry.block.id === id);
  assert.ok(record, `${id} exists in ${storeFile}`);
  return record.block;
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });

// --- team + agent creation, mission agreement --------------------------------

const teamId = model.createTeam({ name: 'Object Model Crew', missionId: 'mission_alpha' });
assert.match(teamId, /^team_/);
assert.equal(blockById(scratch, 'teams.jsonl', teamId).name, 'Object Model Crew');

const agentId = model.createAgent({ name: 'Worker One', provider: 'claude', teamId, missionId: 'mission_alpha' });
assert.equal(blockById(scratch, 'agents.jsonl', agentId).status, 'spawning');

assert.throws(
  () => model.createAgent({ name: 'Lost', provider: 'claude', teamId, missionId: 'mission_beta' }),
  ObjectModelError,
  'agent whose team refs a different mission is rejected',
);
assert.throws(
  () => model.createAgent({ name: 'Ghost', provider: 'claude', teamId: 'team_ghost', missionId: 'mission_alpha' }),
  ObjectModelError,
  'dangling team ref is rejected',
);
console.log('team/agent creation tests passed');

// --- session attach: idempotent, replayable, history-preserving --------------

assert.equal(model.attachAgentSession('agent_not-in-model', 'session-1'), 'unknown', 'non-model agents are not an error');

assert.equal(model.attachAgentSession(agentId, 'session-1'), 'attached');
let agentBlock = blockById(scratch, 'agents.jsonl', agentId);
assert.equal(agentBlock.sessionId, 'session-1');
assert.equal(agentBlock.status, 'live');

assert.equal(model.attachAgentSession(agentId, 'session-1'), 'noop', 'replayed callback is a no-op');

assert.equal(model.attachAgentSession(agentId, 'session-2'), 'attached');
agentBlock = blockById(scratch, 'agents.jsonl', agentId);
assert.equal(agentBlock.sessionId, 'session-2');
assert.deepEqual(agentBlock.sessions, ['session-1'], 'previous Presence rotated into history, never erased (M13)');
console.log('session attach tests passed');

// --- explicit failure record -------------------------------------------------

const doomedId = model.createAgent({ name: 'Doomed', provider: 'codex', teamId, missionId: 'mission_alpha' });
model.markAgentFailed(doomedId, 'PTY launch refused');
const doomed = blockById(scratch, 'agents.jsonl', doomedId);
assert.equal(doomed.status, 'failed');
assert.equal(doomed.failureReason, 'PTY launch refused');
console.log('failure record test passed');

// --- tasks as data: create + transitions -------------------------------------

const taskId = model.createTask({ title: 'Wire the tree', missionId: 'mission_alpha', agentId });
assert.equal(blockById(scratch, 'tasks.jsonl', taskId).status, 'todo');

model.transitionTask(taskId, 'doing');
assert.equal(blockById(scratch, 'tasks.jsonl', taskId).status, 'doing');

model.transitionTask(taskId, 'blocked', 'waiting on snapshot schema');
let taskBlock = blockById(scratch, 'tasks.jsonl', taskId);
assert.equal(taskBlock.status, 'blocked');
assert.equal(taskBlock.blockedReason, 'waiting on snapshot schema');

model.transitionTask(taskId, 'done');
taskBlock = blockById(scratch, 'tasks.jsonl', taskId);
assert.equal(taskBlock.status, 'done');
assert.equal(taskBlock.blockedReason, undefined, 'reason leaves with the blocked status');

assert.throws(() => model.transitionTask(taskId, 'blocked'), ObjectModelError, 'blocked without a reason is rejected');

// A task captured from the vault has no mission behind it — Chris types one
// line and it exists. The schema always allowed this (mission min 0); only the
// write interface insisted on it.
const looseTaskId = model.createTask({ title: 'Buy the domain' });
assert.deepEqual(blockById(scratch, 'tasks.jsonl', looseTaskId).refs, [], 'a task creates with no mission');
assert.equal(blockById(scratch, 'tasks.jsonl', looseTaskId).status, 'todo');

const projectTaskId = model.createTask({
  title: 'Draft the pricing page',
  attachTo: [{ kind: 'project', value: 'proj_alpha' }, { kind: 'kr', value: 'kr_alpha' }],
});
assert.deepEqual(
  blockById(scratch, 'tasks.jsonl', projectTaskId).refs,
  [{ kind: 'project', value: 'proj_alpha' }, { kind: 'kr', value: 'kr_alpha' }],
  'a task hangs off a project and a key result without a mission in between',
);
console.log('task transition tests passed');

// --- thread link + artifact + mission reads ----------------------------------

const threadId = model.createThread({ roomId: 'room_0e74e755', missionId: 'mission_alpha' });
assert.match(threadId, /^thread_/);
assert.equal(model.missionForRoom('room_0e74e755'), 'mission_alpha');
assert.equal(model.missionForRoom('room_unlinked'), null);

const artifactId = model.recordArtifact({ title: 'Tree screenshot', path: 'evidence/tree.png', missionId: 'mission_alpha', taskId });
assert.equal(blockById(scratch, 'artifacts.jsonl', artifactId).path, 'evidence/tree.png');

// Chris, 2026-07-26: you drop the file in first and decide where it belongs
// after. A parentless artifact is the normal case, not an error.
const looseId = model.recordArtifact({ title: 'Loose screenshot', path: 'shots/loose.png' });
assert.deepEqual(blockById(scratch, 'artifacts.jsonl', looseId).refs, [], 'an artifact records with no attachment at all');

const attachedId = model.recordArtifact({
  title: 'Storyboard',
  path: 'design/storyboard.md',
  attachTo: [{ kind: 'project', value: 'proj_alpha' }, { kind: 'kr', value: 'kr_alpha' }, { kind: 'objective', value: 'okr_alpha' }],
});
assert.deepEqual(
  blockById(scratch, 'artifacts.jsonl', attachedId).refs,
  [{ kind: 'project', value: 'proj_alpha' }, { kind: 'kr', value: 'kr_alpha' }, { kind: 'objective', value: 'okr_alpha' }],
  'an artifact attaches to a project, a key result and an objective at once',
);

assert.equal(model.missionForAgent(agentId), 'mission_alpha');
const roster = model.missionAgents('mission_alpha');
assert.deepEqual(roster.map((block) => block.id).sort(), [agentId, doomedId].sort(), 'membership derives from Agent refs');
console.log('thread/artifact/read tests passed');

// --- mission pre-validation read ----------------------------------------------

assert.equal(model.missionRecord('mission_alpha')?.title, 'Alpha');
assert.equal(model.missionRecord('mission_ghost'), null, 'unknown mission resolves to null, never a throw');
console.log('mission read test passed');

// --- team read -----------------------------------------------------------------

assert.equal(model.teamRecord(teamId)?.name, 'Object Model Crew');
assert.equal(model.teamRecord('team_ghost'), null, 'unknown team resolves to null, never a throw');
console.log('team read test passed');

rmSync(scratch, { recursive: true, force: true });
console.log('object-model module tests passed');
