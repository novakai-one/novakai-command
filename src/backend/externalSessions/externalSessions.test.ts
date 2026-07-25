// External-session registration (mission_external-session-visibility): split
// name validation, mission pre-validation, happy path into the durable graph,
// mailbox reuse, failure honesty. Real ObjectModel over temp stores; mailbox
// registry in memory; send seam faked. Run with:
//   npx tsx src/backend/externalSessions/externalSessions.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExternalSessionsHub,
  ExternalSessionNameConflictError,
  ExternalSessionValidationError,
} from './index.js';
import type { ExternalSessionGraph, RegisterExternalResult } from './index.js';
import { ObjectModel } from '../objectModel/index.js';
import { MailboxRegistry } from '../messaging/mailbox/index.js';
import { readStoreDir } from '../stores/store.mjs';

const MISSION = 'mission_alpha';
const STAMP = '2026-07-23T09:00:00+10:00';

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-external-sessions-'));
  writeFileSync(path.join(scratch, 'missions.jsonl'), `${JSON.stringify({ id: MISSION, kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' })}\n`);
  return scratch;
}

function storeBlocks(scratch: string, storeFile: string): Array<Record<string, unknown>> {
  return readStoreDir(scratch).files[storeFile].records.map((entry) => entry.block as Record<string, unknown>);
}

interface SentAnnouncement {
  agentId: string;
  body: string;
  id: string;
}

/** The N4 capability seam: (durable agentId, body) → accepted messageId. */
function fakeSend(sent: SentAnnouncement[]): (agentId: string, body: string) => Promise<{ id: string }> {
  return (agentId, body) => {
    const announcement: SentAnnouncement = { agentId, body, id: `msg_test-${sent.length + 1}` };
    sent.push(announcement);
    return Promise.resolve({ id: announcement.id });
  };
}

interface Rig {
  subject: ExternalSessionsHub;
  model: ObjectModel;
  mailboxes: MailboxRegistry;
  sent: SentAnnouncement[];
  scratch: string;
}

function makeRig(options: { liveNames?: string[]; seedMailbox?: string } = {}): Rig {
  const scratch = scratchStores();
  const model = new ObjectModel({ storesDir: scratch });
  const mailboxes = MailboxRegistry.inMemory();
  if (options.seedMailbox) mailboxes.register({ displayName: options.seedMailbox, memberName: options.seedMailbox });
  const sent: SentAnnouncement[] = [];
  const subject = new ExternalSessionsHub(model, mailboxes, fakeSend(sent), () => options.liveNames ?? []);
  return { subject, model, mailboxes, sent, scratch };
}

const INPUT = { name: 'chief-kimi-2', provider: 'kimi', sessionId: 'session_c8d39318-test', missionId: MISSION };

// --- happy path: team + agent + Presence + mailbox + announcement -----------

{
  const { subject, model, mailboxes, sent, scratch } = makeRig();
  const result = await subject.register(INPUT);
  assert.match(result.agentId, /^agent_/);
  assert.equal(result.mailbox, 'created');
  assert.equal(result.announcement, 'sent');
  assert.ok(result.envelopeId, 'announcement carries its envelope id');

  const agent = model.agentRecord(result.agentId);
  assert.ok(agent, 'durable Agent block exists');
  assert.equal(agent.status, 'live');
  assert.equal(agent.sessionId, INPUT.sessionId, 'Presence attached');
  assert.deepEqual(
    agent.refs.map((reference) => `${reference.kind}:${reference.value}`).sort(),
    [`mission:${MISSION}`, `team:${result.teamId}`].sort(),
    'exactly one team + one mission ref',
  );
  assert.equal(storeBlocks(scratch, 'teams.jsonl')[0].id, result.teamId, 'team block persisted');
  assert.ok(mailboxes.identityFor(INPUT.name), 'mailbox registered');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agentId, result.agentId, 'the announcement authenticates AS the durable agent (N4)');
  assert.match(sent[0].body, /registered as durable agent/, 'announcement body lands for Chris');
  rmSync(scratch, { recursive: true, force: true });
  console.log('happy path test passed');
}

// --- mailbox reuse: the pinned chief-kimi-2 case -----------------------------

{
  const { subject, scratch } = makeRig({ seedMailbox: INPUT.name });
  const result = await subject.register(INPUT);
  assert.equal(result.mailbox, 'existing', 'existing mailbox is reused, never a conflict');
  rmSync(scratch, { recursive: true, force: true });
  console.log('mailbox reuse test passed');
}

// --- split name validation: live-PTY collision rejects, nothing written ------

{
  const { subject, scratch } = makeRig({ liveNames: [INPUT.name] });
  await assert.rejects(() => subject.register(INPUT), ExternalSessionNameConflictError);
  assert.equal(storeBlocks(scratch, 'agents.jsonl').length, 0, 'no agent block on rejection');
  assert.equal(storeBlocks(scratch, 'teams.jsonl').length, 0, 'no team block on rejection');
  rmSync(scratch, { recursive: true, force: true });
  console.log('live-name collision test passed');
}

// --- mission pre-validation: unknown mission rejects BEFORE any write --------

{
  const { subject, scratch } = makeRig();
  await assert.rejects(
    () => subject.register({ ...INPUT, missionId: 'mission_ghost' }),
    ExternalSessionValidationError,
  );
  assert.equal(storeBlocks(scratch, 'teams.jsonl').length, 0, 'orphan team is structurally impossible');
  assert.equal(storeBlocks(scratch, 'agents.jsonl').length, 0);
  rmSync(scratch, { recursive: true, force: true });
  console.log('mission pre-validation test passed');
}

// --- input validation ---------------------------------------------------------

{
  const { subject, scratch } = makeRig();
  await assert.rejects(() => subject.register({ ...INPUT, provider: 'fable' }), ExternalSessionValidationError);
  await assert.rejects(() => subject.register({ ...INPUT, name: '#team' }), ExternalSessionValidationError);
  await assert.rejects(() => subject.register({ ...INPUT, sessionId: ' ' }), ExternalSessionValidationError);
  rmSync(scratch, { recursive: true, force: true });
  console.log('input validation tests passed');
}

// --- failure honesty: a failed agent is marked explicitly, never silent -------

{
  const failed: Array<[string, string]> = [];
  const sabotaged: ExternalSessionGraph = {
    missionRecord: () => ({ id: MISSION }),
    createTeam: () => 'team_sab',
    createAgent: () => 'agent_sab',
    attachAgentSession: () => {
      throw new Error('store exploded');
    },
    markAgentFailed: (agentId, reason) => {
      failed.push([agentId, reason]);
    },
    agentForSession: () => null,
  };
  const subject = new ExternalSessionsHub(sabotaged, MailboxRegistry.inMemory(), fakeSend([]), () => []);
  await assert.rejects(() => subject.register(INPUT), /store exploded/);
  assert.deepEqual(failed, [['agent_sab', 'store exploded']], 'failed agent carries the reason');
  console.log('failure honesty test passed');
}

// --- announcement outcomes: failure reported, registration stands ------------

{
  const scratch = scratchStores();
  const model = new ObjectModel({ storesDir: scratch });
  const failingSend = (): Promise<{ id: string }> => Promise.reject(new Error('router down'));
  const subject = new ExternalSessionsHub(model, MailboxRegistry.inMemory(), failingSend, () => []);
  const result: RegisterExternalResult = await subject.register(INPUT);
  assert.equal(result.announcement, 'failed');
  assert.equal(result.announcementError, 'router down');
  assert.equal(model.agentRecord(result.agentId)?.status, 'live', 'registration stands on its own');

  const quiet = await subject.register({ ...INPUT, name: 'quiet-one', announce: false });
  assert.equal(quiet.announcement, 'skipped');
  rmSync(scratch, { recursive: true, force: true });
  console.log('announcement outcome tests passed');
}

// --- idempotent per session (Ruling 1b): re-registration never double-mints --

{
  const { subject, model, scratch } = makeRig();
  const first = await subject.register(INPUT);
  const second = await subject.register(INPUT); // the redeploy re-run case
  assert.equal(second.agentId, first.agentId, 'same session → same durable Agent, no second mint');
  assert.equal(second.teamId, first.teamId);
  assert.equal(storeBlocks(scratch, 'agents.jsonl').length, 1, 'one agent block after two registrations');
  assert.equal(storeBlocks(scratch, 'teams.jsonl').length, 1, 'one team block after two registrations');
  assert.equal(model.agentRecord(first.agentId)?.sessionId, INPUT.sessionId, 'Presence still attached');
  // A genuinely NEW session mints its own Agent (idempotency is per-session, not per-name).
  const other = await subject.register({ ...INPUT, sessionId: 'session_other-session' });
  assert.notEqual(other.agentId, first.agentId);
  assert.equal(storeBlocks(scratch, 'agents.jsonl').length, 2);
  rmSync(scratch, { recursive: true, force: true });
  console.log('idempotent registration test passed');
}

console.log('external-sessions module tests passed');
