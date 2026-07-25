/**
 * messagingV2 boot proof (slice N1): startMessagingV2 against a REAL
 * ObjectModel fixture and a tmp journal, then the capability is exercised
 * THROUGH THE PUBLIC CONTRACT ONLY (composition/embedded + public contract
 * types): GetCapabilities, authenticate by durable agentId token, a 1-1
 * SendMessage with clientMessageId idempotency, recipient inbox/messages,
 * clean close, and a torn-tail journal restart (store-jsonl truncates the
 * partial tail line and boots). Run with `npx tsx src/backend/messagingV2/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MessagingSession, Outcome } from '../../../packages/messaging/public/capability.js';
import { MessagingError } from '../../../packages/messaging/public/contract/index.js';
import { ObjectModel } from '../objectModel/index.js';
import { personIdForAgentId } from './authority/index.js';
import { startMessagingV2 } from './index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-boot-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'),
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }) + '\n');
  return scratch;
}

function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.kind !== 'ok') {
    throw new Error(`expected ok, got ${outcome.error.name}: ${outcome.error.message}`);
  }
  return outcome.value;
}

const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const teamId = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const aliceId = model.createAgent({ name: 'chief-kimi', provider: 'kimi', teamId, missionId: 'mission_alpha' });
const bobId = model.createAgent({ name: 'worker-bob', provider: 'claude', teamId, missionId: 'mission_alpha' });
const alicePerson = personIdForAgentId(aliceId);
const bobPerson = personIdForAgentId(bobId);

const journalPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-journal-')), 'journal.jsonl');
const bootLogs: string[] = [];

// --- boot ---------------------------------------------------------------------

const handle = await startMessagingV2({
  objectModel: model,
  storePath: journalPath,
  'log': (message) => bootLogs.push(message),
});
assert.ok(
  bootLogs.some((line) => line.startsWith('[messaging-v2] capability booted') && line.includes('principals=2')),
  `boot log line names the store and principal count, got: ${JSON.stringify(bootLogs)}`,
);
console.log('boot test passed');

// --- GetCapabilities (pre-auth discovery, R3) -------------------------------------

const capabilities = handle.embedded.getCapabilities();
assert.equal(typeof capabilities.contractVersion, 'string');
assert.equal(typeof capabilities.protocolVersion, 'string');
assert.ok(capabilities.limits.messageMaxBytes > 0);
console.log('getCapabilities test passed');

// --- authenticate through the public contract --------------------------------------

const rejected = await handle.embedded.authenticate({ token: 'agent_00000000-0000-0000-0000-000000000000' });
assert.equal(rejected.kind, 'rejected', 'unknown durable id is NotAuthenticated');

const aliceAuth = await handle.embedded.authenticate({ token: aliceId });
const bobAuth = await handle.embedded.authenticate({ token: bobId });
assert.equal(aliceAuth.kind, 'authenticated');
assert.equal(bobAuth.kind, 'authenticated');
if (aliceAuth.kind !== 'authenticated' || bobAuth.kind !== 'authenticated') throw new Error('unreachable');
assert.equal(aliceAuth.principal.personId, alicePerson);
assert.equal(bobAuth.principal.personId, bobPerson);
assert.deepEqual(aliceAuth.principal.grants, ['priority.override'], 'chief-* asserts Chief');
const alice: MessagingSession = aliceAuth.session;
const bobSession: MessagingSession = bobAuth.session;
console.log('authenticate tests passed');

// --- 1-1 send (clientMessageId idempotency) ------------------------------------------

// First contact is deliberate (DEC-14): bob allowlists alice before the send.
unwrap(await bobSession.setContactPolicy({ allowlist: [alicePerson], defaultRule: 'deny' }));

const sendInput = {
  address: `person:${bobPerson}`,
  body: { text: 'n1 boot hello' },
  priority: 'normal',
  clientMessageId: 'n1-boot-1',
};
const accepted = unwrap(await alice.sendMessage(sendInput));
assert.match(accepted.messageId, /^message_/);
assert.match(accepted.threadId, /^thread_/);

// Same clientMessageId + same content → the ORIGINAL acceptance (DEC-13/A5).
const retry = unwrap(await alice.sendMessage(sendInput));
assert.equal(retry.messageId, accepted.messageId);
assert.equal(retry.duplicate, true);
console.log('sendMessage tests passed');

// --- recipient reads reflect the message ------------------------------------------------

const inbox = unwrap(await bobSession.getInbox({}));
assert.ok(
  inbox.messages.some((message) => message.id === accepted.messageId),
  'recipient inbox reflects the accepted message',
);
const page = unwrap(await bobSession.getMessages({ threadId: accepted.threadId }));
assert.ok(
  page.messages.some(
    (message) => message.id === accepted.messageId && message.body.text === 'n1 boot hello',
  ),
  'thread messages reflect the sent body',
);
console.log('recipient read tests passed');

// --- close settles cleanly ------------------------------------------------------------------

await handle.close();
console.log('close test passed');

// --- torn-tail journal: a crash mid-append is truncated, the capability boots ----------------

appendFileSync(journalPath, '{"op":"createThrea');
const rebooted = await startMessagingV2({
  objectModel: model,
  storePath: journalPath,
  'log': (message) => bootLogs.push(message),
});
assert.ok(
  bootLogs.filter((line) => line.startsWith('[messaging-v2] capability booted')).length === 2,
  'torn-tail journal truncates and the capability boots again',
);
const aliceReboot = await rebooted.embedded.authenticate({ token: aliceId });
assert.equal(aliceReboot.kind, 'authenticated', 'sessions authenticate against the recovered store');
if (aliceReboot.kind === 'authenticated') {
  const recovered = unwrap(await aliceReboot.session.getMessages({ threadId: accepted.threadId }));
  assert.ok(
    recovered.messages.some((message) => message.id === accepted.messageId),
    'the durable acceptance survives the torn-tail restart',
  );
}
await rebooted.close();
console.log('torn-tail restart test passed');

rmSync(scratch, { recursive: true, force: true });
console.log('messagingV2 boot proof passed');
