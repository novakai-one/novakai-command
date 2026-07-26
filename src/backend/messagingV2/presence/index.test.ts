/**
 * messagingV2 presence glue tests (slice N2): launch → presence opened+bound;
 * boot lanes for already-running live agents; plain spawns skipped; exit →
 * liveness disconnect through the core's single close path; the spawn
 * briefing lands through the TerminalRuntime submit lane. Real embedded
 * stack over a memory store + real ObjectModel fixture; fake TerminalRuntime
 * for PTY effects. Run with `npx tsx src/backend/messagingV2/presence/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSystemClock } from '../../../../packages/messaging/adapters/clock-system.js';
import { createMemoryStore } from '../../../../packages/messaging/adapters/store-memory.js';
import { createEmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { ObjectModel } from '../../objectModel/index.js';
import { createNovakaiAuthority, personIdForAgentId } from '../authority/index.js';
import { createNovakaiMembership } from '../membership/index.js';
import { createTerminalHostTransport } from '../transport/index.js';
import { createAgentLaneGlue } from './index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-presence-'));
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
  private readonly exitListeners: Array<(agentId: string, exitCode: number | null) => void> = [];
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
  onExit(callback: (agentId: string, exitCode: number | null) => void): void { this.exitListeners.push(callback); }
  onSession(): void {}
  exitAgent(agentId: string): void {
    this.agents = this.agents.map((agent) =>
      agent.agentId === agentId ? { ...agent, status: 'exited' } : agent);
    for (const callback of this.exitListeners) callback(agentId, 0);
  }
  /** Put a (re-launched) running agent back on the roster. */
  restore(info: AgentInfo): void {
    this.agents = [...this.agents.filter((agent) => agent.agentId !== info.agentId), info];
  }
}

async function ticks(rounds = 10): Promise<void> {
  for (let count = 0; count < rounds; count += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const teamId = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const aliceId = model.createAgent({ name: 'chief-kimi', provider: 'kimi', teamId, missionId: 'mission_alpha' });
const bobId = model.createAgent({ name: 'worker-b', provider: 'claude', teamId, missionId: 'mission_alpha' });
// carol shares NO team/mission ref with the crew — deny-by-default must hold for her.
const otherTeam = model.createTeam({ name: 'Other Crew', missionId: 'mission_beta' });
const carolId = model.createAgent({ name: 'worker-c', provider: 'claude', teamId: otherTeam, missionId: 'mission_beta' });
const alicePerson = personIdForAgentId(aliceId);
const bobPerson = personIdForAgentId(bobId);
const carolPerson = personIdForAgentId(carolId);
const aliceInfo = agentInfo(aliceId, 'chief-kimi', 'kimi');
const bobInfo = agentInfo(bobId, 'worker-b');
const plainInfo = agentInfo('agent_plain', 'plain-1');

const clock = createSystemClock();
const terminals = new FakeTerminalRuntime([aliceInfo, bobInfo, plainInfo]);
const transport = createTerminalHostTransport(terminals);
const embedded = createEmbeddedMessaging({
  clock,
  store: createMemoryStore(clock),
  authority: createNovakaiAuthority(model, clock, {
    humans: [{ token: 'human-secret', personId: 'person_user-chris' as never, roles: ['Human'] }],
  }),
  membership: createNovakaiMembership(model, clock),
  transports: [transport],
});
await embedded.start();
const glueLogs: string[] = [];
const glue = createAgentLaneGlue({
  embedded, transport, terminals, objectModel: model, humanToken: 'human-secret',
  briefingDelayMs: 5, 'log': (line) => glueLogs.push(line),
});

// --- boot lanes: already-running durable agents get presence; plain spawns don't ----

await glue.openBootLanes();
assert.equal(glue.laneCount(), 2, 'durable live agents got lanes at boot');
assert.equal(transport.boundCount, 2, 'both presences are bound to terminal lanes');
const alicePresences = embedded.registry.presencesFor(personIdForAgentId(aliceId));
assert.equal(alicePresences.length, 1);
assert.equal(alicePresences[0]?.transport, 'pty');
assert.equal(alicePresences[0]?.clientLabel, aliceId, 'clientLabel carries the agentId');
assert.equal(embedded.registry.presencesFor(personIdForAgentId(plainInfo.agentId)).length, 0,
  'plain spawns have no durable record → no presence (accepted limitation)');
assert.ok(glueLogs.some((line) => line.includes('2/3')), 'boot log counts the roster');
console.log('boot lane tests passed');

// --- D-N2-5 team contact bootstrap (host policy; DEC-14 deny-by-default intact) ------

async function allowlistFor(token: string): Promise<unknown> {
  const auth = await embedded.authenticate({ token });
  if (auth.kind !== 'authenticated') throw new Error('unreachable');
  const policy = await auth.session.getPolicy({});
  if (policy.kind !== 'ok') throw new Error('unreachable');
  return policy.value.contact;
}

const aliceContact = await allowlistFor(aliceId) as { allowlist: string[]; defaultRule: string };
assert.ok(aliceContact.allowlist.includes(bobPerson), 'co-member bob is reachable by alice');
assert.ok(aliceContact.allowlist.includes('person_user-chris'), 'the human principal is reachable by alice');
assert.ok(!aliceContact.allowlist.includes(carolPerson), 'carol shares no ref — NOT allowlisted');
assert.equal(aliceContact.defaultRule, 'deny', 'deny-by-default preserved');
const humanContact = await allowlistFor('human-secret') as { allowlist: string[] };
for (const personId of [alicePerson, bobPerson, carolPerson]) {
  assert.ok(humanContact.allowlist.includes(personId), `human allowlist seeds durable team agent ${personId}`);
}
console.log('contact bootstrap policy tests passed');

// agent→chris DMs send cleanly (delivery pends until N4 — expected); carol stays 403.
const aliceAuth = await embedded.authenticate({ token: aliceId });
if (aliceAuth.kind !== 'authenticated') throw new Error('unreachable');
const toChris = await aliceAuth.session.sendMessage({
  address: 'person:person_user-chris', body: { text: 'boss ping' },
  priority: 'normal', clientMessageId: 'n2-policy-1',
});
assert.equal(toChris.kind, 'ok', 'agent→human DM accepted (delivery pends — N4)');
const toCarol = await aliceAuth.session.sendMessage({
  address: `person:${carolPerson}`, body: { text: 'stranger ping' },
  priority: 'normal', clientMessageId: 'n2-policy-2',
});
assert.equal(toCarol.kind, 'error', 'non-co-member stays blocked');
if (toCarol.kind === 'error') assert.equal(toCarol.error.name, 'BlockedByContactPolicy', 'DEC-14 intact');
console.log('bootstrap send-outcome tests passed');

// --- exit → liveness disconnect through the core's single close path (R9) -----------

terminals.exitAgent(bobId);
await ticks();
assert.equal(embedded.registry.presencesFor(personIdForAgentId(bobId)).length, 0,
  'the exited agent presence closed');
assert.equal(transport.boundCount, 1, 'the binding dropped with the lane');
console.log('liveness disconnect test passed');

// --- launch → lane opens, then the briefing lands through the submit lane -----------

terminals.exitAgent(aliceId); // prove a re-launch re-opens the closed lane
await ticks();
const relaunchedAlice = agentInfo(aliceId, 'chief-kimi', 'kimi');
terminals.restore(relaunchedAlice);
glue.handleAgentLaunched(relaunchedAlice);
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(
  embedded.registry.presencesFor(personIdForAgentId(aliceId)).length,
  1,
  'a relaunched agent gets a FRESH presence (the stale session must not suppress it)',
);
const aliceBriefing = terminals.submissions.at(-1)?.text ?? '';
assert.match(aliceBriefing, /\[nvk-msg briefing\] You are agent "chief-kimi"/, 'briefing names the agent');
assert.match(aliceBriefing, /send --to '#team'/, 'briefing teaches the fleet room post (N3)');
assert.equal(terminals.submissions.at(-1)?.agentId, aliceId, 'briefing rides the submit lane, never PtyDelivery');
console.log('launch briefing test passed');

// --- plain spawn: the unavailable note, never the protocol ----------------------------

glue.handleAgentLaunched(plainInfo);
await new Promise((resolve) => setTimeout(resolve, 60));
const plainBriefing = terminals.submissions.at(-1)?.text ?? '';
assert.match(plainBriefing, /unavailable for non-mission agents/, 'plain spawn hears messaging is unavailable');
assert.ok(!plainBriefing.includes('send --to'), 'plain spawn is not taught the send verb');
console.log('plain-spawn briefing test passed');

// --- an agent gone before the delay is never briefed ------------------------------------

const ghostInfo = agentInfo('agent_ghost', 'ghost-1');
const before = terminals.submissions.length;
glue.handleAgentLaunched(ghostInfo);
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(terminals.submissions.length, before, 'no briefing typed for an agent missing from the roster');
console.log('dead-agent briefing test passed');

// --- audit #6: a policy-sync failure must never flip a live lane's briefing --------------

terminals.restore(bobInfo); // bob is live again; his lane re-opens on launch
glue.handleAgentLaunched(bobInfo);
await new Promise((resolve) => setTimeout(resolve, 60));
const realListAgents = model.listAgents.bind(model);
model.listAgents = (() => { throw new Error('stores on fire'); }) as typeof model.listAgents;
glue.handleAgentLaunched(bobInfo); // openLane: registry hit → true; the sync then throws
await new Promise((resolve) => setTimeout(resolve, 60));
model.listAgents = realListAgents;
const resilientBriefing = terminals.submissions.at(-1)?.text ?? '';
assert.match(resilientBriefing, /\[nvk-msg briefing\] You are agent "worker-b"/);
assert.ok(
  resilientBriefing.includes('send --to'),
  'a policy-sync failure must NOT flip the briefing to "messaging unavailable" — the lane is open',
);
console.log('policy-failure lane resilience test passed');

// --- hotfix: the held human session self-heals at ~50% of the TTL ---------------
// Root cause (production, serve.out): the N3.1 self-minted human session was
// minted ONCE at boot with the authority's 1h TTL; at expiry every consumer
// (live subscribe, user routes, rooms glue) fetched the same dead session
// forever. The glue must re-mint on a timer and clean that timer up on close.

const renewClock = createSystemClock();
const renewEmbedded = createEmbeddedMessaging({
  clock: renewClock,
  store: createMemoryStore(renewClock),
  authority: createNovakaiAuthority(model, renewClock, {
    sessionTtlMs: 400,
    humans: [{ token: 'human-secret', personId: 'person_user-chris' as never, roles: ['Human'] }],
  }),
  membership: createNovakaiMembership(model, renewClock),
  transports: [createTerminalHostTransport(terminals)],
});
await renewEmbedded.start();
let humanAuthCalls = 0;
const realAuthenticate = renewEmbedded.authenticate.bind(renewEmbedded);
renewEmbedded.authenticate = (credential: unknown) => {
  if ((credential as { token?: string }).token === 'human-secret') humanAuthCalls += 1;
  return realAuthenticate(credential);
};
const renewGlue = createAgentLaneGlue({
  embedded: renewEmbedded, transport: createTerminalHostTransport(terminals), terminals,
  objectModel: model, humanToken: 'human-secret', briefingDelayMs: 5, 'log': () => {},
});
await renewGlue.openBootLanes();
const staleSession = renewGlue.humanSession();
assert.ok(staleSession !== null, 'the human session is held at boot');
const mintedAtBoot = humanAuthCalls;
assert.ok(mintedAtBoot >= 1, 'the human session was minted once at boot');

await new Promise((resolve) => setTimeout(resolve, 700)); // TTL 400 ms → re-mint due at ~200 ms
const warmSession = renewGlue.humanSession();
assert.ok(warmSession !== null);
assert.notEqual(
  warmSession.principal.sessionId, staleSession.principal.sessionId,
  'after expiry the held session is a FRESH re-mint, never the dead one',
);
assert.ok(humanAuthCalls > mintedAtBoot, 'authenticate ran again for the human principal');

await renewGlue.close();
const callsAtClose = humanAuthCalls;
await new Promise((resolve) => setTimeout(resolve, 700));
assert.equal(humanAuthCalls, callsAtClose, 'close() clears the renewal timer — no re-mint afterwards');
await renewEmbedded.close();
console.log('human session renewal tests passed');

await glue.close();
await embedded.close();
rmSync(scratch, { recursive: true, force: true });
console.log('presence glue tests passed');
