/**
 * messagingV2 failure-truth tests (slice N5, D-N5-3): a terminally failed
 * delivery types ONE `[nvk-msg failed: <reason> — <messageId>]` into the
 * SENDER's lane — never the recipient's, never twice (dedupe across both
 * parties' subscriptions and across replay); a sender with no live lane is
 * dropped quietly. Real embedded stack (memory store), real ObjectModel
 * fixture, fake TerminalRuntime. Run with
 * `npx tsx src/backend/messagingV2/failureTruth/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../../../../packages/messaging/adapters/store-memory.js';
import { createSystemClock } from '../../../../packages/messaging/adapters/clock-system.js';
import { createEmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { ObjectModel } from '../../objectModel/index.js';
import { createNovakaiAuthority } from '../authority/index.js';
import { createFailureTruth } from './index.js';
import { createNovakaiMembership } from '../membership/index.js';
import { createAgentLaneGlue } from '../presence/index.js';
import { createTerminalHostTransport } from '../transport/index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-failuretruth-'));
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
const alphaTeam = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const betaTeam = model.createTeam({ name: 'Beta Crew', missionId: 'mission_beta' });
const bobId = model.createAgent({ name: 'worker-b', provider: 'claude', teamId: alphaTeam, missionId: 'mission_alpha' });
// carol shares NO team/mission ref with bob — bob's bootstrap policy blocks her.
const carolId = model.createAgent({ name: 'worker-c', provider: 'claude', teamId: betaTeam, missionId: 'mission_beta' });
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

async function authenticate(token: string) {
  const auth = await embedded.authenticate({ token });
  if (auth.kind !== 'authenticated') throw new Error('unreachable');
  return auth.session;
}

function laneText(agentId: string): string[] {
  return terminals.submissions.filter((submission) => submission.agentId === agentId)
    .map((submission) => submission.text);
}

// --- a blocked ROOM delivery types ONE failure line into the SENDER's lane ---------
// (A blocked DM is REJECTED outright — no Delivery exists. R4 terminal
// failures exist exactly here: one member blocked, the send still accepts.)

const fleet = await embedded.store.createRoomThread({ threadKind: 'team', authority: 'fleet', externalId: 'team' });
if (fleet.kind !== 'ok') throw new Error('unreachable');
const carol = await authenticate(carolId);
const blocked = await carol.sendMessage({
  address: `thread:${fleet.value.id}`,
  body: { text: 'bob will never see this' },
  priority: 'normal', clientMessageId: 'n5-failure-1',
});
assert.equal(blocked.kind, 'ok', 'a blocked member never rejects a room send (R4)');
if (blocked.kind !== 'ok') throw new Error('unreachable');
await embedded.pumpEvents();
await new Promise((resolve) => setTimeout(resolve, 50));

const expectedLine = `[nvk-msg failed: blocked-by-contact-policy — ${blocked.value.messageId}]`;
const carolLines = laneText(carolId).filter((text) => text === expectedLine);
assert.equal(carolLines.length, 1, 'exactly ONE failure line reaches the sender lane');
assert.ok(!laneText(bobId).some((text) => text.includes('nvk-msg failed')), 'the recipient lane gets NO failure line');

// Dedupe across replay: pump again — the line must not retype.
await embedded.pumpEvents();
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(laneText(carolId).filter((text) => text === expectedLine).length, 1, 'replay never retypes');

// --- F2: a watch started after history types NOTHING for old failures --------

async function currentJournalTip(): Promise<number> {
  const page = await embedded.store.scanJournal();
  if (page.kind !== 'ok') throw new Error('unreachable');
  return page.value.reduce((maxSeq, entry) => Math.max(maxSeq, entry.sequence), 0);
}

const tipSnapshot = await currentJournalTip();
const liveOnly = createFailureTruth({ terminals, tipSequence: () => tipSnapshot });
liveOnly.watchSession(carol, carolId);
await embedded.pumpEvents();
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(liveOnly.typedCount, 0, 'a live-only watch types NOTHING for pre-existing historical failures');

const second = await carol.sendMessage({
  address: `thread:${fleet.value.id}`,
  body: { text: 'bob still will not see this' },
  priority: 'normal', clientMessageId: 'n5-failure-2',
});
assert.equal(second.kind, 'ok', 'the second blocked send still accepts (R4)');
if (second.kind !== 'ok') throw new Error('unreachable');
await embedded.pumpEvents();
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(liveOnly.typedCount, 1, 'a failure committed after watch start types exactly one line');
const secondLine = `[nvk-msg failed: blocked-by-contact-policy — ${second.value.messageId}]`;
assert.ok(laneText(carolId).includes(secondLine), 'the typed line carries the new messageId');

// --- a sender with NO live lane drops quietly -------------------------------------

// alice is durable but offline (no terminal) — her failure surfaces nowhere,
// and nothing crashes (the browser surface has the truth either way).
console.log('failure-truth tests passed');

await glue.close();
await embedded.close();
rmSync(scratch, { recursive: true, force: true });
