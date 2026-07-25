/**
 * F3 regression tests: the ops-watchdog identity is a co-member of EVERYONE
 * (union semantics — policy/index.ts derives contact from shared team/mission
 * refs), so its fleet-room alerts commit ZERO failed deliveries even with
 * agents spread over multiple missions and teams. Real ObjectModel on tmp
 * stores, real embedded stack (memory store), fake TerminalRuntime. Run with
 * `npx tsx src/backend/server/watchdogIdentity/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../../../../packages/messaging/adapters/store-memory.js';
import { createSystemClock } from '../../../../packages/messaging/adapters/clock-system.js';
import { createEmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { ObjectModel } from '../../objectModel/index.js';
import { createNovakaiAuthority, personIdForAgentId } from '../../messagingV2/authority/index.js';
import { createNovakaiMembership } from '../../messagingV2/membership/index.js';
import { createAgentLaneGlue } from '../../messagingV2/presence/index.js';
import { createTerminalHostTransport } from '../../messagingV2/transport/index.js';
import { ensureWatchdogIdentity, WATCHDOG_AGENT_NAME } from './index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-watchdog-identity-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'), [
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }),
    JSON.stringify({ id: 'mission_beta', kind: 'mission', 'ts': STAMP, title: 'Beta', owner: 'chief' }),
  ].join('\n') + '\n');
  return scratch;
}

function agentInfo(agentId: string, title: string): AgentInfo {
  return {
    agentId, title, provider: 'claude', sessionId: 'session',
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
const alphaTeam = model.createTeam({ name: 'Alpha Crew', missionId: 'mission_alpha' });
const betaTeam = model.createTeam({ name: 'Beta Crew', missionId: 'mission_beta' });
const bobId = model.createAgent({ name: 'worker-b', provider: 'claude', teamId: alphaTeam, missionId: 'mission_alpha' });
const carolId = model.createAgent({ name: 'worker-c', provider: 'claude', teamId: betaTeam, missionId: 'mission_beta' });

// --- refs union + idempotency -------------------------------------------------

const watchdogId = ensureWatchdogIdentity(model);
assert.ok(watchdogId !== null, 'identity resolves with missions present');
const refValues = new Set((model.agentRecord(watchdogId)?.refs ?? []).map((entry) => `${entry.kind}:${entry.value}`));
for (const expected of [alphaTeam, betaTeam, 'mission_alpha', 'mission_beta']) {
  const held = refValues.has(`team:${expected}`) || refValues.has(`mission:${expected}`);
  assert.ok(held, `watchdog is a member of ${expected}`);
}
const opsTeamId = model.listTeams().find((team) => team['name'] === 'ops')?.['id'];
assert.ok(typeof opsTeamId === 'string', 'the ops team exists');
assert.ok(refValues.has(`team:${opsTeamId as string}`), 'watchdog is in its own ops team');

const agentsLines = (): number => readFileSync(path.join(scratch, 'agents.jsonl'), 'utf8').trim().split('\n').length;
const beforeRerun = agentsLines();
const rerunId = ensureWatchdogIdentity(model);
assert.equal(rerunId, watchdogId, 'find-or-create is stable');
assert.equal(agentsLines(), beforeRerun, 'a second ensure appends NOTHING (idempotent)');
assert.equal(model.listAgents().filter((agent) => agent.name === WATCHDOG_AGENT_NAME).length, 1, 'exactly one watchdog agent');
console.log('refs-union tests passed');

// --- no missions → null (log-only sink posture) --------------------------------

const emptyScratch = mkdtempSync(path.join(tmpdir(), 'nvk-watchdog-empty-'));
for (const name of STORE_FILES) writeFileSync(path.join(emptyScratch, name), '');
const emptyModel = new ObjectModel({ storesDir: emptyScratch });
assert.equal(ensureWatchdogIdentity(emptyModel), null, 'no mission record → null');
rmSync(emptyScratch, { recursive: true, force: true });
console.log('no-mission tests passed');

// --- e2e: a fleet alert from the watchdog commits ZERO failed deliveries -------

const terminals = new FakeTerminalRuntime([agentInfo(bobId, 'worker-b'), agentInfo(carolId, 'worker-c')]);
const clock = createSystemClock();
const transport = createTerminalHostTransport(terminals);
const embedded = createEmbeddedMessaging({
  clock,
  store: createMemoryStore(clock),
  authority: createNovakaiAuthority(model, clock, {
    humans: [{ token: 'human-secret', personId: 'person_user-chris' as never, roles: ['Human'] }],
  }),
  membership: createNovakaiMembership(model, clock, 'person_user-chris' as never),
  transports: [transport],
});
await embedded.start();
const glue = createAgentLaneGlue({
  embedded, transport, terminals, objectModel: model, humanToken: 'human-secret',
  briefingDelayMs: 5, 'log': () => {},
});
await glue.openBootLanes();
await embedded.pumpEvents();

async function authenticate(token: string) {
  const auth = await embedded.authenticate({ token });
  if (auth.kind !== 'authenticated') throw new Error('unreachable');
  return auth.session;
}

const watchdogPerson = personIdForAgentId(watchdogId);
for (const agentId of [bobId, carolId]) {
  const policy = await (await authenticate(agentId)).getPolicy({});
  if (policy.kind !== 'ok') throw new Error('unreachable');
  assert.ok(
    policy.value.contact.allowlist.includes(watchdogPerson),
    `${agentId} allowlists the watchdog after boot sync (co-member via unioned refs)`,
  );
}

const fleet = await embedded.store.createRoomThread({ threadKind: 'team', authority: 'fleet', externalId: 'team' });
if (fleet.kind !== 'ok') throw new Error('unreachable');
const alert = await (await authenticate(watchdogId)).sendMessage({
  address: `thread:${fleet.value.id}`,
  body: { text: 'worker-b has gone quiet for ~25 min with nothing pending — worth a look.' },
  priority: 'normal', clientMessageId: 'f3-alert-1',
});
assert.equal(alert.kind, 'ok', 'the fleet alert accepts');
if (alert.kind !== 'ok') throw new Error('unreachable');
await embedded.pumpEvents();

const deliveries = await (await authenticate(watchdogId)).getDelivery({ messageId: alert.value.messageId });
if (deliveries.kind !== 'ok') throw new Error('unreachable');
const failed = deliveries.value.deliveries.filter((delivery) => delivery.state === 'failed');
assert.equal(failed.length, 0, 'ZERO failed deliveries with agents over 2 missions + 2 teams');
assert.ok(deliveries.value.deliveries.length >= 3, 'bob + carol + human (+self) all got a delivery');
console.log('zero-failed-deliveries tests passed');

await glue.close();
await embedded.close();
rmSync(scratch, { recursive: true, force: true });
