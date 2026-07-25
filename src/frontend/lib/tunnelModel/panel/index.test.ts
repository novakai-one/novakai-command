// Shared panel view-model (mission_mission-control-ux, Task 2.3): one
// agentId-keyed row set both rails render. Composed duplicate-name test per
// ruling msg_d528e320; M1 parity = same underlying set + order, chrome only
// windows it. Run with:
//   npx tsx src/frontend/lib/tunnelModel/panel/index.test.ts
import assert from 'node:assert/strict';
import type { PersonView } from '../../../../shared/people/schema.js';
import { buildPanelLanes, mergeArchive, type PanelPersonRow } from './index.js';
import { dmId, type Conversation } from '../../messagingV2/index.js';

/** The tier the backend would derive for these inputs (Ruling 3) — fixtures
 * default to it so tests read like the real projection. Explicit overrides win. */
function defaultLiveness(base: { durableStatus: PersonView['durableStatus']; runtime: PersonView['runtime'] }): PersonView['liveness'] {
  if (base.runtime?.status === 'running') return 'live';
  if (base.durableStatus === 'retired') return 'retired';
  if (base.durableStatus === 'failed') return 'failed';
  if (base.runtime?.status === 'exited') return 'exited';
  if (base.durableStatus === 'live' || base.durableStatus === 'spawning') return 'external-verified';
  return 'exited';
}

function person(overrides: Partial<PersonView> & { agentId: string; name: string }): PersonView {
  const base = {
    provider: 'kimi', durableStatus: 'live' as const, missionId: 'mission_x', teamId: 'team_x',
    runtime: null, sessionId: null, updated: null,
    ...overrides,
  };
  return { ...base, liveness: overrides.liveness ?? defaultLiveness(base) };
}

function dmLane(name: string, lastMessageAt?: string): Conversation {
  return { id: dmId(name), kind: 'dm', title: name, ...(lastMessageAt ? { lastMessageAt } : {}) };
}

function roomLane(id: string, title: string, lastMessageAt?: string): Conversation {
  return { id, kind: 'room', title, members: ['chris'], ...(lastMessageAt ? { lastMessageAt } : {}) };
}

const CHANNEL: Conversation = { id: '#team', kind: 'channel', title: '#team' };

// --- buckets: live first, quiet = has-a-lane, archived = retired/dead -------
{
  const people = [
    person({ agentId: 'agent_live-durable', name: 'chief-kimi-4', durableStatus: 'live', sessionId: 'session_ext' }), // external chief: live, no runtime
    person({ agentId: 'agent_running', name: 'Worker Fable UX', runtime: { status: 'running' } }),
    person({ agentId: 'agent_retired', name: 'Worker Old', durableStatus: 'retired' }),
    person({ agentId: 'rt_exited-with-lane', name: 'Accept Probe III', durableStatus: null, runtime: { status: 'exited' } }),
    person({ agentId: 'rt_exited-dead', name: 'perf-verify', durableStatus: null, runtime: { status: 'exited' } }),
  ];
  const lanes = [CHANNEL, dmLane('Accept Probe III', '2026-07-23T03:00:00Z'), dmLane('chief-kimi-4', '2026-07-23T02:00:00Z')];
  const panel = buildPanelLanes(lanes, people, []);
  assert.deepEqual(panel.live.map((personRow) => personRow.rowId), ['agent_live-durable', 'agent_running'],
    'durable-live external chief and running worker are live (alpha within bucket)');
  assert.deepEqual(panel.quiet.map((personRow) => personRow.rowId), ['rt_exited-with-lane'],
    'exited runtime with a Chris-party lane stays reachable, recency-ordered');
  assert.deepEqual(panel.archived.map((personRow) => personRow.rowId), ['rt_exited-dead', 'agent_retired'],
    'retired durable + dead sessions (exited, no lane) leave the default view (alpha by name)');
  assert.deepEqual(panel.rooms.map((lane) => lane.id), ['#team'], 'channel pinned in rooms');
}

// --- Ruling 3: unverified ghosts leave the live bucket; ordering law --------
{
  const people = [
    person({ agentId: 'agent_ghost', name: 'Worker Messages Builder', durableStatus: 'live', liveness: 'unverified' }),
    person({ agentId: 'agent_ext', name: 'chief-kimi-7', durableStatus: 'live', liveness: 'external-verified' }),
    person({ agentId: 'agent_split', name: 'Manager Kimi Messages', durableStatus: 'live', runtime: { status: 'exited' }, liveness: 'exited' }),
  ];
  const panel = buildPanelLanes([CHANNEL], people, []);
  assert.deepEqual(panel.live.map((personRow) => personRow.rowId), ['agent_ext'],
    'only live/external-verified sit in the live bucket — a stale durable-live ghost never does');
  assert.deepEqual(panel.quiet.map((personRow) => personRow.rowId).sort(), ['agent_ghost', 'agent_split'],
    'unverified + runtime-exited both read quiet — a dead agent never reads healthier than a live one');
  assert.equal(panel.archived.length, 0);
}

// --- composed duplicate-name (ruled): two people, one mailbox, both visible --
{
  const people = [
    person({ agentId: 'agent_dup-1', name: 'Manager Kimi Visibility', durableStatus: 'retired' }),
    person({ agentId: 'agent_dup-2', name: 'Manager Kimi Visibility', durableStatus: 'live' }),
  ];
  const panel = buildPanelLanes([CHANNEL], people, []);
  const rows: PanelPersonRow[] = [...panel.live, ...panel.quiet, ...panel.archived];
  const duplicated = rows.filter((personRow) => personRow.person?.name === 'Manager Kimi Visibility');
  assert.equal(duplicated.length, 2, 'two DISTINCT rows — no name folding');
  assert.notEqual(duplicated[0].rowId, duplicated[1].rowId);
  // Known, filed transport limitation stated by the test: both rows address
  // the SAME dm:<name> mailbox until the external-envelope-id gap closes.
  assert.equal(duplicated[0].conversationId, duplicated[1].conversationId);
  assert.equal(duplicated[0].conversationId, dmId('Manager Kimi Visibility'));
}

// --- lane-only rows (feed-history name, no identity) keep the lane visible ---
{
  const lanes = [CHANNEL, dmLane('ghost-of-feed', '2026-07-22T10:00:00Z')];
  const panel = buildPanelLanes(lanes, [], []);
  assert.equal(panel.quiet.length, 1);
  assert.equal(panel.quiet[0].person, null, 'identity unknown is stated, not invented');
  assert.equal(panel.quiet[0].rowId, dmId('ghost-of-feed'), 'rowId falls back to the lane id only when NO durable identity exists');
}

// --- M1 parity: same data → one order; each chrome windows a prefix ----------
{
  const people = Array.from({ length: 12 }, (_unused, index) =>
    person({ agentId: `agent_${String(index).padStart(2, '0')}`, name: `Agent ${String(index).padStart(2, '0')}`, runtime: { status: 'running' } }));
  const rooms = Array.from({ length: 9 }, (_unused, index) =>
    roomLane(`room_${index}`, `room-${index}`, `2026-07-2${index % 3}T0${index % 9}:00:00Z`));
  const lanes = [CHANNEL, ...rooms];
  const first = buildPanelLanes(lanes, people, []);
  const second = buildPanelLanes(lanes, people, []);
  assert.deepEqual(first.rooms.map((lane) => lane.id), second.rooms.map((lane) => lane.id), 'deterministic');
  // Chrome windows (Messages cap, MC ROOM_LIMIT) must be prefixes of THIS order.
  const messagesWindow = first.rooms.slice(0, 50);
  const missionControlWindow = first.rooms.slice(0, 5);
  assert.deepEqual(missionControlWindow, first.rooms.slice(0, 5));
  assert.deepEqual(messagesWindow.slice(0, 5), missionControlWindow, 'both windows are prefixes of one shared order');
  const liveIds = first.live.map((personRow) => personRow.rowId);
  assert.deepEqual([...liveIds].sort(), liveIds, 'live bucket deterministic (alpha)');
}

// --- S1 default view: archived room-lane ids leave the rooms bucket ----------
{
  const lanes = [CHANNEL, roomLane('room_live', 'live room', '2026-07-23T01:00:00Z'), roomLane('room_closed', 'closed room', '2026-07-23T02:00:00Z')];
  const panel = buildPanelLanes(lanes, [], [], ['room_closed']);
  assert.deepEqual(panel.rooms.map((lane) => lane.id), ['#team', 'room_live'],
    'closed-mission/archived rooms are absent by default; the disclosure read reaches them');
}

// --- archive merge (S1/Task 5.3): fetched wins, client fills, ids stable -----
{
  const fetched = [
    { id: 'room_dead', kind: 'room' as const, title: 'Legacy tab room', conversationId: 'room_dead', reason: 'room-archived' as const, missionId: null, sourceRefs: [] },
    { id: 'agent_ret', kind: 'person' as const, title: 'Worker Old', conversationId: 'dm:Worker Old', reason: 'person-retired' as const, missionId: null, sourceRefs: [{ store: 'agents' }] },
  ];
  const clientRows = [
    { rowId: 'agent_ret', conversationId: dmId('Worker Old'), person: person({ agentId: 'agent_ret', name: 'Worker Old', durableStatus: 'retired' }), lane: null },
    { rowId: 'rt_dead', conversationId: dmId('perf-verify'), person: person({ agentId: 'rt_dead', name: 'perf-verify', durableStatus: null, runtime: { status: 'exited' } }), lane: null },
  ];
  const merged = mergeArchive(fetched, clientRows);
  assert.deepEqual(merged.map((lane) => lane.id), ['room_dead', 'rt_dead', 'agent_ret'],
    'rooms first; fetched person wins its id; client fills the dead session');
  assert.equal(merged.find((lane) => lane.id === 'agent_ret')?.sourceRefs.length, 1, 'fetched row (with provenance) beat the client row');
}

console.log('panel lanes: all assertions passed');
