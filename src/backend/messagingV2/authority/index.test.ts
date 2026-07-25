/**
 * messagingV2 authority adapter tests (slice N1): ObjectModel-backed
 * Authority + ProvisioningDirectory. Real ObjectModel instances against
 * fixture stores in os.tmpdir() — no mocks of ObjectModel. The adapter is
 * constructed directly (its own seam); the messaging capability is crossed
 * only via seam headers (types/helpers) and the public contract (id
 * patterns, grants). Run with `npx tsx src/backend/messagingV2/authority/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessagingError, idPatterns } from '../../../../packages/messaging/public/contract/index.js';
import type { PersonId, Timestamp } from '../../../../packages/messaging/public/contract/index.js';
import type { ClockIds } from '../../../../packages/messaging/seams/clock.js';
import { ObjectModel } from '../../objectModel/index.js';
import { readStoreDir, replaceLine } from '../../stores/store.mjs';
import { createNovakaiAuthority, personIdForAgentId } from './index.js';

const STAMP = '2026-07-22T10:00:00+10:00';
const STORE_FILES = [
  'decisions.jsonl', 'requests.jsonl', 'missions.jsonl', 'tasks.jsonl', 'captains-log.jsonl',
  'learnings.jsonl', 'okrs.jsonl', 'projects.jsonl', 'issues.jsonl',
  'teams.jsonl', 'agents.jsonl', 'artifacts.jsonl', 'threads.jsonl',
];

// A test-local clock: the adapters under test never mint ids, only read time.
const clock: ClockIds = {
  'now': () => new Date().toISOString() as Timestamp,
  newId: (() => {
    throw new Error('newId is unused by the messagingV2 authority adapter');
  }) as ClockIds['newId'],
};

function scratchStores(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-authority-'));
  for (const name of STORE_FILES) writeFileSync(path.join(scratch, name), '');
  writeFileSync(path.join(scratch, 'missions.jsonl'),
    JSON.stringify({ id: 'mission_alpha', kind: 'mission', 'ts': STAMP, title: 'Alpha', owner: 'chief' }) + '\n');
  return scratch;
}

/** Flip a durable agent's lifecycle state through the store engine (CAS).
 * `updated` must move STRICTLY forward — two flips inside one millisecond
 * collide without the floor+1 guard (the N1 CI-flake class). */
function setAgentStatus(scratch: string, agentId: string, status: string): void {
  const record = readStoreDir(scratch).files['agents.jsonl'].records
    .find((entry: { block: { id?: string; updated?: unknown } }) => entry.block.id === agentId);
  assert.ok(record, `${agentId} exists in agents.jsonl`);
  const previousMs = Date.parse(typeof record.block.updated === 'string' ? record.block.updated : '') || 0;
  const updated = new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
  replaceLine(scratch, 'agents.jsonl', agentId,
    JSON.stringify({ ...record.block, status, updated }), { expectedRaw: record.raw });
}

const PERSON_PATTERN = new RegExp(idPatterns.PersonId);
const scratch = scratchStores();
const model = new ObjectModel({ storesDir: scratch });
const teamId = model.createTeam({ name: 'Messaging Crew', missionId: 'mission_alpha' });
const chiefId = model.createAgent({ name: 'chief-kimi', provider: 'kimi', teamId, missionId: 'mission_alpha' });
const workerId = model.createAgent({ name: 'worker-one', provider: 'claude', teamId, missionId: 'mission_alpha' });
const retiredId = model.createAgent({ name: 'worker-gone', provider: 'claude', teamId, missionId: 'mission_alpha' });
const failedId = model.createAgent({ name: 'worker-doomed', provider: 'codex', teamId, missionId: 'mission_alpha' });
setAgentStatus(scratch, retiredId, 'retired');
model.markAgentFailed(failedId, 'PTY launch refused');

const authority = createNovakaiAuthority(model, clock, {
  humans: [{ token: 'human-secret', personId: 'person_user-chris' as PersonId, roles: ['Human'] }],
});

// --- authenticate: agents by durable agentId token ----------------------------

const chiefAuth = await authority.authenticate({ token: chiefId });
assert.equal(chiefAuth.kind, 'authenticated');
if (chiefAuth.kind !== 'authenticated') throw new Error('unreachable');
const chiefPerson = personIdForAgentId(chiefId);
assert.equal(chiefAuth.principal.personId, chiefPerson);
assert.ok(PERSON_PATTERN.test(chiefPerson), 'derived personId matches the contract PersonId pattern');
assert.deepEqual(chiefAuth.principal.grants, ['priority.override'], 'chief-* name asserts the Chief role (D4)');
assert.match(chiefAuth.principal.sessionId, /^session_\d+$/, 'adapter-minted runtime session id');
console.log('agent authenticate tests passed');

const workerAuth = await authority.authenticate({ token: workerId });
assert.equal(workerAuth.kind, 'authenticated');
if (workerAuth.kind !== 'authenticated') throw new Error('unreachable');
assert.deepEqual(workerAuth.principal.grants, [], 'no name convention, no grants');

const workerReAuth = await authority.authenticate({ token: workerId });
if (workerReAuth.kind !== 'authenticated') throw new Error('unreachable');
assert.notEqual(workerReAuth.principal.sessionId, workerAuth.principal.sessionId, 'each authenticate mints a fresh session');

// --- authenticate: rejections -------------------------------------------------

for (const credential of [undefined, null, 'token', 42, {}, { token: 7 }]) {
  const outcome = await authority.authenticate(credential);
  assert.equal(outcome.kind, 'rejected', `malformed credential ${JSON.stringify(credential)} is rejected, never a throw`);
}
for (const token of ['agent_00000000-0000-0000-0000-000000000000', retiredId, failedId]) {
  const outcome = await authority.authenticate({ token });
  assert.equal(outcome.kind, 'rejected', `unknown/retired/failed token ${token} is rejected`);
  if (outcome.kind === 'rejected') assert.equal(outcome.error.name, 'NotAuthenticated');
}
console.log('rejection tests passed');

// --- authenticate: configured humans -------------------------------------------

const humanAuth = await authority.authenticate({ token: 'human-secret' });
assert.equal(humanAuth.kind, 'authenticated');
if (humanAuth.kind !== 'authenticated') throw new Error('unreachable');
assert.equal(humanAuth.principal.personId, 'person_user-chris');
assert.deepEqual(humanAuth.principal.grants, ['priority.override'], 'Human role maps via DEFAULT_ROLE_GRANTS');
console.log('human authenticate test passed');

// --- revalidate (Seams §2.1) ---------------------------------------------------

const revalid = await authority.revalidate(chiefAuth.principal.sessionId);
assert.equal(revalid.kind, 'valid');
if (revalid.kind === 'valid') assert.deepEqual(revalid.principal.grants, ['priority.override'], 'fresh grants');

setAgentStatus(scratch, chiefId, 'retired');
const afterRetire = await authority.revalidate(chiefAuth.principal.sessionId);
assert.equal(afterRetire.kind, 'invalid', 'agent retired mid-session ends the session');
setAgentStatus(scratch, chiefId, 'live');

authority.invalidateSession(workerAuth.principal.sessionId);
assert.equal((await authority.revalidate(workerAuth.principal.sessionId)).kind, 'invalid', 'invalidated session');
assert.equal((await authority.revalidate('session_999')).kind, 'invalid', 'unknown session');
console.log('revalidate tests passed');

// --- failure vocabulary ---------------------------------------------------------

authority.setUnavailable(true);
assert.equal((await authority.authenticate({ token: workerId })).kind, 'unavailable');
assert.equal((await authority.revalidate(chiefAuth.principal.sessionId)).kind, 'unavailable');
authority.setUnavailable(false);
console.log('unavailable tests passed');

// --- provisioning directory ------------------------------------------------------

assert.equal(await authority.isProvisioned(personIdForAgentId(workerId)), true, 'live/spawning agent is provisioned');
assert.equal(await authority.isProvisioned(personIdForAgentId(chiefId)), true, 'chief is provisioned');
assert.equal(await authority.isProvisioned(personIdForAgentId(retiredId)), false, 'retired agent is NOT provisioned');
assert.equal(await authority.isProvisioned(personIdForAgentId(failedId)), false, 'failed agent is NOT provisioned');
assert.equal(await authority.isProvisioned('person_user-chris' as PersonId), true, 'configured human is provisioned');
assert.equal(await authority.isProvisioned('person_ghost' as PersonId), false, 'unknown person is not provisioned');
console.log('isProvisioned tests passed');

// G6: an ObjectModel read failure must surface as DependencyUnavailable
// (a thrown MessagingError the core maps to a typed outcome) — never a
// silent `false` deny, never a raw exception. See the adapter header.
rmSync(scratch, { recursive: true, force: true });
await assert.rejects(
  () => authority.isProvisioned(personIdForAgentId(workerId)),
  (error: unknown) => error instanceof MessagingError && error.name === 'DependencyUnavailable',
);
console.log('isProvisioned dependency-failure test passed');

// --- construction-time config validation (fail fast, Seams §1) -------------------

const validModel = new ObjectModel({ storesDir: scratchStores() });
assert.throws(
  () => createNovakaiAuthority(validModel, clock, { roleGrants: { Chief: ['not-a-grant' as never] } }),
  (error: unknown) => error instanceof MessagingError && error.name === 'DependencyUnavailable',
  'unknown grant in roleGrants fails construction');
assert.throws(
  () => createNovakaiAuthority(validModel, clock, { humans: [{ token: '', personId: 'person_x' as PersonId }] }),
  MessagingError,
  'empty human token fails construction');
assert.throws(
  () => createNovakaiAuthority(validModel, clock, { humans: [{ token: 't', personId: 'user_chris' as PersonId }] }),
  MessagingError,
  'malformed personId fails construction');
console.log('config validation tests passed');

// --- session pruning (N1 audit finding 5) --------------------------------------------

const pruneModel = new ObjectModel({ storesDir: scratchStores() });
const pruneTeam = pruneModel.createTeam({ name: 'Prune Crew', missionId: 'mission_alpha' });
const pruneAgent = pruneModel.createAgent({ name: 'worker-prune', provider: 'kimi', teamId: pruneTeam, missionId: 'mission_alpha' });
const prunable = createNovakaiAuthority(pruneModel, clock, { sessionTtlMs: 20 });
const first = await prunable.authenticate({ token: pruneAgent });
assert.equal(first.kind, 'authenticated');
assert.equal(prunable.sessionCount(), 1);
await new Promise((resolve) => setTimeout(resolve, 30)); // let the first session expire
const second = await prunable.authenticate({ token: pruneAgent });
assert.equal(second.kind, 'authenticated');
assert.equal(prunable.sessionCount(), 1, 'the expired session is pruned at the next authenticate (finding 5)');
if (first.kind === 'authenticated') {
  assert.equal((await prunable.revalidate(first.principal.sessionId)).kind, 'invalid');
  assert.equal(prunable.sessionCount(), 1, 'revalidate deletes the expired entry at the point of truth');
}
console.log('session pruning tests passed');

console.log('messagingV2 authority adapter tests passed');
