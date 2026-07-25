/**
 * messagingV2 REST route tests (slice N2 — the two-agents-converse proof,
 * in-process): a real express app over the v2 routes, a real embedded
 * capability (JSONL journal in tmp), a real ObjectModel fixture, and a fake
 * TerminalRuntime capturing submit-lane effects. Agent A sends through
 * POST /api/messaging/v2/send → agent B's lane receives the formatted
 * [nvk-msg …] submission; B replies through the same route → A's lane
 * receives it. Auth failures → 401; #team → 400. Run with
 * `npx tsx src/backend/messagingV2/routes/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { ObjectModel } from '../../objectModel/index.js';
import { personIdForAgentId } from '../authority/index.js';
import { startMessagingV2 } from '../index.js';
import { registerMessagingV2Routes } from './index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-routes-'));
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
const teamId = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const aliceId = model.createAgent({ name: 'chief-kimi', provider: 'kimi', teamId, missionId: 'mission_alpha' });
const bobId = model.createAgent({ name: 'worker-b', provider: 'claude', teamId, missionId: 'mission_alpha' });
// carol shares NO team/mission ref with the crew — deny-by-default must hold.
const otherTeam = model.createTeam({ name: 'Other Crew', missionId: 'mission_beta' });
const carolId = model.createAgent({ name: 'worker-c', provider: 'claude', teamId: otherTeam, missionId: 'mission_beta' });
const alicePerson = personIdForAgentId(aliceId);
const bobPerson = personIdForAgentId(bobId);
const carolPerson = personIdForAgentId(carolId);
const terminals = new FakeTerminalRuntime([
  agentInfo(aliceId, 'chief-kimi', 'kimi'),
  agentInfo(bobId, 'worker-b'),
  agentInfo(carolId, 'worker-c'),
]);

const journalPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-route-journal-')), 'journal.jsonl');
const handle = await startMessagingV2({
  objectModel: model, storePath: journalPath, terminals, humanToken: 'human-secret', 'log': () => {},
});

const application = express();
application.use(express.json());
registerMessagingV2Routes(application, { getHandle: () => handle, terminals, objectModel: model });
const server: Server = await new Promise((resolve) => {
  const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function v2send(token: string | null, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/messaging/v2/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

async function v2get(token: string, route: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

// --- auth: rejected and missing tokens → 401 -----------------------------------------

assert.equal((await v2send(null, { 'to': 'worker-b', body: 'x' })).status, 401, 'no token → 401');
assert.equal(
  (await v2send('agent_00000000-0000-0000-0000-000000000000', { 'to': 'worker-b', body: 'x' })).status,
  401,
  'unknown durable id → 401',
);
console.log('auth rejection tests passed');

// --- D-N2-5: co-members converse with NO manual setContactPolicy ------------------------
// (the glue's team contact bootstrap seeded the allowlists at boot)

const first = await v2send(aliceId, { 'to': 'worker-b', body: 'hello bob' });
assert.equal(first.status, 200, JSON.stringify(first.json));
assert.match(String(first.json['messageId']), /^message_/);
const toBob = terminals.submissions.at(-1);
assert.equal(toBob?.agentId, bobId, "A's send landed on B's lane");
assert.equal(
  toBob?.text,
  `[nvk-msg from chief-kimi id ${String(first.json['messageId'])}] hello bob`,
  'the addressed lane carries the formatted prefix',
);
assert.equal(toBob?.flushMs, undefined, 'bob is claude — no kimi flush');

const reply = await v2send(bobId, { 'to': 'chief-kimi', body: 'hi alice' });
assert.equal(reply.status, 200, JSON.stringify(reply.json));
const toAlice = terminals.submissions.at(-1);
assert.equal(toAlice?.agentId, aliceId, "B's reply landed on A's lane");
assert.equal(toAlice?.text, `[nvk-msg from worker-b id ${String(reply.json['messageId'])}] hi alice`);
assert.equal(toAlice?.flushMs, 6000, 'alice is kimi — the flush rides');
console.log('two-agents-converse proof passed (no manual setContactPolicy — D-N2-5)');

// --- deny-by-default intact + manual setContactPolicy still works (contract command) ----

const stranger = await v2send(aliceId, { 'to': 'worker-c', body: 'stranger ping' });
assert.equal(stranger.status, 403, 'carol shares no team/mission ref → BlockedByContactPolicy');
assert.match(String(stranger.json['name']), /BlockedByContactPolicy/);

const carolAuth = await handle.embedded.authenticate({ token: carolId });
if (carolAuth.kind !== 'authenticated') throw new Error('unreachable');
const manual = await carolAuth.session.setContactPolicy({ allowlist: [alicePerson], defaultRule: 'deny' });
assert.equal(manual.kind, 'ok', 'manual policy remains a first-class contract command');
const welcomed = await v2send(aliceId, { 'to': 'worker-c', body: 'now reachable' });
assert.equal(welcomed.status, 200, 'a manual allowlist admits the non-co-member');
assert.equal(terminals.submissions.at(-1)?.agentId, carolId);
console.log('deny-by-default + manual policy tests passed');

// --- the human principal's allowlist is seeded at boot --------------------------------------

const humanAuth = await handle.embedded.authenticate({ token: 'human-secret' });
if (humanAuth.kind !== 'authenticated') throw new Error('unreachable');
assert.equal(humanAuth.principal.personId, 'person_user-chris');
const humanPolicy = await humanAuth.session.getPolicy({});
if (humanPolicy.kind !== 'ok') throw new Error('unreachable');
for (const personId of [alicePerson, bobPerson, carolPerson]) {
  assert.ok(humanPolicy.value.contact.allowlist.includes(personId), `human allowlist seeds ${personId}`);
}
console.log('human allowlist seeding test passed');

// --- reads: thread messages, inbox, address book -------------------------------------------

const thread = await v2get(aliceId, `/api/messaging/v2/messages?with=${encodeURIComponent('worker-b')}`);
assert.equal(thread.status, 200);
const bodies = (thread.json['messages'] as Array<{ body: { text: string } }>).map((message) => message.body.text);
assert.deepEqual(bodies, ['hello bob', 'hi alice'], 'the shared DM thread');

const inbox = await v2get(bobId, '/api/messaging/v2/inbox');
assert.equal(inbox.status, 200);
assert.deepEqual(
  inbox.json['messages'],
  [],
  '§11.2: the inbox holds non-terminal deliveries only — delivered mail reads via the thread',
);

const book = await v2get(aliceId, '/api/messaging/v2/address-book');
assert.equal(book.status, 200);
const entries = book.json['agents'] as Array<Record<string, unknown>>;
assert.deepEqual(entries.map((entry) => entry['name']), ['chief-kimi', 'worker-b', 'worker-c']);
assert.equal(entries[0]?.['personId'], alicePerson, 'name → personId for CLI resolution');
assert.equal(typeof entries[0]?.['status'], 'string', 'durable status rides along');
console.log('read tests passed');

// --- interrupt: urgent leads with Esc; MSG-010 downgrade is DND-conditional --------------

await v2send(aliceId, { 'to': 'worker-b', body: 'urgent question', interrupt: true });
assert.deepEqual(terminals.submissions.at(-1)?.leadIn, { data: '\x1b', settleMs: 400 },
  'urgent carries the Esc lead-in inside the lane (C2)');

// bob has no priority.override, but alice is NOT under DND → no downgrade
// (MSG-010 qualifies urgent-vs-DND bypass, never grant-less urgency alone).
const plainUrgent = await v2send(bobId, { 'to': 'chief-kimi', body: 'also urgent', interrupt: true });
assert.equal(plainUrgent.status, 200);
assert.equal(plainUrgent.json['urgentDowngraded'], undefined);
assert.deepEqual(terminals.submissions.at(-1)?.leadIn, { data: '\x1b', settleMs: 400 });

// alice under DND: bob's urgent downgrades and HOLDS (dnd-hold) — nothing is
// typed until the release re-drives the attempt (W1, R5).
const aliceAuth = await handle.embedded.authenticate({ token: aliceId });
if (aliceAuth.kind !== 'authenticated') throw new Error('unreachable');
await aliceAuth.session.setDndPolicy({ enabled: true });
const submissionsBeforeHold = terminals.submissions.length;
const held = await v2send(bobId, { 'to': 'chief-kimi', body: 'held urgent', interrupt: true });
assert.equal(held.status, 200);
assert.equal(held.json['urgentDowngraded'], true, 'urgent vs DND without the grant downgrades honestly');
assert.equal(terminals.submissions.length, submissionsBeforeHold, 'a held delivery types nothing');
const heldInbox = await v2get(aliceId, '/api/messaging/v2/inbox');
assert.ok(
  (heldInbox.json['messages'] as Array<{ body: { text: string } }>).some((message) => message.body.text === 'held urgent'),
  'a held delivery shows in the recipient inbox (§11.2 non-terminal)',
);
await aliceAuth.session.setDndPolicy({ enabled: false });
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(terminals.submissions.length, submissionsBeforeHold + 1, 'the DND release resumed the attempt');
assert.match(terminals.submissions.at(-1)?.text ?? '', /held urgent/);
console.log('interrupt + DND tests passed');

// --- #team → 400 (rooms land in N3) -------------------------------------------------------

const channel = await v2send(aliceId, { 'to': '#team', body: 'status' });
assert.equal(channel.status, 400);
assert.match(String(channel.json['error']), /N3/);
console.log('channel rejection test passed');

await handle.close();
server.close();
rmSync(scratch, { recursive: true, force: true });
console.log('messagingV2 route tests passed');
