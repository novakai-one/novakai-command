// People adapter (mission_mission-control-ux, M2): mount fetch, reconnect
// refetch through the REAL agentSocket wiring, failed-read keeps the last
// good list under an honest stale flag. Run with:
//   npx tsx src/frontend/lib/tunnelModel/people.test.ts
import assert from 'node:assert/strict';
import type { PersonView } from '../../../../shared/people/schema.js';
import { emptyPeopleSnapshot, mountPeople, visibleLanesFor, type PeopleSnapshot } from './index.js';

// --- F2 (audit): an incoming-only DM lane is NEVER pruned --------------------
// R3 serves only the human's own direct threads — every dm lane with feed
// history is human-party by contract. The old chrisParty rule (from ===
// 'chris') pruned incoming-only lanes. Both rails share visibleLanesFor.
{
  const lanes = [
    { id: 'dm:worker-b', kind: 'dm' as const, title: 'worker-b' },
    { id: '#team', kind: 'channel' as const, title: '#team' },
  ];
  const incomingOnly = [
    { id: 'm1', from: 'worker-b', to: 'dm:worker-b', delivery: 'normal' as const, body: 'ping chris', createdAt: 'T', status: 'delivered' as const },
  ];
  const visible = visibleLanesFor(lanes, incomingOnly, []).map((lane) => lane.id);
  assert.ok(visible.includes('dm:worker-b'), 'incoming-only DM lane stays visible (R3: served DMs are human-party)');
  assert.ok(visible.includes('#team'));
  console.log('F2 incoming-only lane visibility test passed');
}

function person(overrides: Partial<PersonView> & { agentId: string; name: string }): PersonView {
  return {
    provider: 'kimi', durableStatus: 'live', liveness: 'live', missionId: 'mission_x', teamId: 'team_x',
    runtime: null, sessionId: null, updated: null,
    ...overrides,
  };
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public targetUrl: string) { FakeSocket.instances.push(this); }
  send(): void {}
  triggerOpen(): void { this.readyState = 1; this.onopen?.(); }
  triggerClose(): void { this.readyState = 3; this.onclose?.(); }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

const { setBackoffForTest } = await import('../../agentSocket/index.js');
setBackoffForTest(5, 20);

let served: PersonView[] | 'fail' = [];
let fetches = 0;
globalThis.fetch = (async (requestUrl: unknown) => {
  assert.equal(String(requestUrl), '/api/people');
  fetches += 1;
  if (served === 'fail') throw new Error('backend down');
  return { json: async () => ({ people: served, asOf: '2026-07-23T04:00:00.000Z' }) };
}) as typeof fetch;

function tracked(): { current: () => PeopleSnapshot; apply: (update: (current: PeopleSnapshot) => PeopleSnapshot) => void } {
  let snapshot = emptyPeopleSnapshot();
  return { current: () => snapshot, apply: (update) => { snapshot = update(snapshot); } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// --- mount fetch loads the directory ----------------------------------------
{
  served = [person({ agentId: 'agent_a', name: 'Manager Kimi UX' })];
  const { current, apply } = tracked();
  const unmount = mountPeople(apply);
  await settle();
  assert.equal(current().loaded, true);
  assert.equal(current().stale, false);
  assert.deepEqual(current().people.map((entry) => entry.agentId), ['agent_a']);
  unmount();
}

// --- failed fetch keeps last-good under stale; recovery clears it -----------
{
  served = [person({ agentId: 'agent_a', name: 'Manager Kimi UX' })];
  const { current, apply } = tracked();
  const unmount = mountPeople(apply);
  await settle();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  served = 'fail';
  socket.triggerOpen(); // reconnect trigger fires a refetch that fails
  await settle();
  assert.equal(current().stale, true, 'failure is visible');
  assert.deepEqual(current().people.map((entry) => entry.agentId), ['agent_a'], 'last-good list retained');
  // chief registered during the outage — recovery must surface him without a reload
  served = [person({ agentId: 'agent_a', name: 'Manager Kimi UX' }), person({ agentId: 'agent_chief', name: 'chief-kimi-4', sessionId: 'session_ext' })];
  socket.triggerClose();
  await settle();
  FakeSocket.instances[FakeSocket.instances.length - 1].triggerOpen();
  await settle();
  assert.equal(current().stale, false, 'recovery clears stale');
  assert.deepEqual(current().people.map((entry) => entry.agentId), ['agent_a', 'agent_chief']);
  unmount();
}

// --- unmount stops updates ----------------------------------------------------
{
  served = [];
  const { current, apply } = tracked();
  const unmount = mountPeople(apply);
  await settle();
  unmount();
  const before = fetches;
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.triggerClose();
  await settle();
  FakeSocket.instances[FakeSocket.instances.length - 1].triggerOpen();
  await settle();
  assert.equal(fetches, before, 'no refetch after unmount');
  assert.equal(current().loaded, true);
}

console.log('people adapter: all assertions passed');
