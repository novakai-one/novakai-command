/**
 * messagingV2 authority adapter tests (slice N1; D-N6-2 token migration):
 * ObjectModel-backed Authority + ProvisioningDirectory. Real ObjectModel
 * instances against fixture stores in os.tmpdir() — no mocks of ObjectModel.
 * D-N6-2: agent credentials are ISSUED tokens (nvkt_<64 hex>, hash-only at
 * rest in the token store) — the raw durable agentId is REJECTED (D-N2-2
 * retired). Revocation kills authentication AND §2.1 revalidation.
 * Run with `npx tsx src/backend/messagingV2/authority/index.test.ts`.
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
import { createTokenStore } from '../tokens/index.js';
import { createExternalsStore } from '../externals/index.js';
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

const tokenPath = path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-authtokens-')), 'tokens.jsonl');
const tokens = createTokenStore(tokenPath);
const authority = createNovakaiAuthority(model, clock, {
  humans: [{ token: 'human-secret', personId: 'person_user-chris' as PersonId, roles: ['Human'] }],
  tokenStore: tokens,
});

// --- D-N6-2: issued tokens authenticate; the raw agentId is REJECTED --------------

const chiefToken = tokens.issue(chiefId).token;
const chiefAuth = await authority.authenticate({ token: chiefToken });
assert.equal(chiefAuth.kind, 'authenticated', 'an issued nvkt_ token authenticates');
if (chiefAuth.kind !== 'authenticated') throw new Error('unreachable');
const chiefPerson = personIdForAgentId(chiefId);
assert.equal(chiefAuth.principal.personId, chiefPerson);
assert.ok(PERSON_PATTERN.test(chiefPerson), 'derived personId matches the contract PersonId pattern');
assert.deepEqual(chiefAuth.principal.grants, ['priority.override'], 'chief-* name asserts the Chief role (D4)');
assert.match(chiefAuth.principal.sessionId, /^session_\d+$/, 'adapter-minted runtime session id');

for (const legacyId of [chiefId, workerId]) {
  const legacy = await authority.authenticate({ token: legacyId });
  assert.equal(legacy.kind, 'rejected', `raw agentId ${legacyId} is REJECTED — D-N2-2 is retired`);
  if (legacy.kind === 'rejected') assert.equal(legacy.error.name, 'NotAuthenticated');
}
console.log('D-N6-2 token authenticate + agentId retirement tests passed');

const workerToken = tokens.issue(workerId).token;
const workerAuth = await authority.authenticate({ token: workerToken });
assert.equal(workerAuth.kind, 'authenticated');
if (workerAuth.kind !== 'authenticated') throw new Error('unreachable');
assert.deepEqual(workerAuth.principal.grants, [], 'no name convention, no grants');

const workerReAuth = await authority.authenticate({ token: workerToken });
if (workerReAuth.kind !== 'authenticated') throw new Error('unreachable');
assert.notEqual(workerReAuth.principal.sessionId, workerAuth.principal.sessionId, 'each authenticate mints a fresh session');
console.log('agent authenticate tests passed');

// --- authenticate: rejections -------------------------------------------------

for (const credential of [undefined, null, 'token', 42, {}, { token: 7 }]) {
  const outcome = await authority.authenticate(credential);
  assert.equal(outcome.kind, 'rejected', `malformed credential ${JSON.stringify(credential)} is rejected, never a throw`);
}
const unknownNvkt = `nvkt_${'0'.repeat(64)}`;
for (const token of [unknownNvkt, tokens.issue(retiredId).token, tokens.issue(failedId).token]) {
  const outcome = await authority.authenticate({ token });
  assert.equal(outcome.kind, 'rejected', `unknown/retired/failed token is rejected`);
  if (outcome.kind === 'rejected') assert.equal(outcome.error.name, 'NotAuthenticated');
}
console.log('rejection tests passed');

// --- D-N6-2: revocation kills authentication AND revalidation ----------------------

const revocable = await authority.authenticate({ token: workerToken });
assert.equal(revocable.kind, 'authenticated');
if (revocable.kind !== 'authenticated') throw new Error('unreachable');
assert.equal((await authority.revalidate(revocable.principal.sessionId)).kind, 'valid', 'live token revalidates');
tokens.revokeAll(workerId);
const revokedAuth = await authority.authenticate({ token: workerToken });
assert.equal(revokedAuth.kind, 'rejected', 'a revoked token never authenticates');
assert.equal(
  (await authority.revalidate(revocable.principal.sessionId)).kind,
  'invalid',
  'revalidate after revocation ends the session (§2.1)',
);
console.log('revocation tests passed');

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

authority.invalidateSession(chiefAuth.principal.sessionId);
assert.equal((await authority.revalidate(chiefAuth.principal.sessionId)).kind, 'invalid', 'invalidated session');
assert.equal((await authority.revalidate('session_999')).kind, 'invalid', 'unknown session');
console.log('revalidate tests passed');

// --- failure vocabulary ---------------------------------------------------------

authority.setUnavailable(true);
assert.equal((await authority.authenticate({ token: chiefToken })).kind, 'unavailable');
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
  () => createNovakaiAuthority(validModel, clock, { tokenStore: createTokenStore(path.join(mkdtempSync(path.join(tmpdir(), 'nvk-tk-a-')), 't.jsonl')), roleGrants: { Chief: ['not-a-grant' as never] } }),
  (error: unknown) => error instanceof MessagingError && error.name === 'DependencyUnavailable',
  'unknown grant in roleGrants fails construction');
assert.throws(
  () => createNovakaiAuthority(validModel, clock, { tokenStore: createTokenStore(path.join(mkdtempSync(path.join(tmpdir(), 'nvk-tk-b-')), 't.jsonl')), humans: [{ token: '', personId: 'person_x' as PersonId }] }),
  MessagingError,
  'empty human token fails construction');
assert.throws(
  () => createNovakaiAuthority(validModel, clock, { tokenStore: createTokenStore(path.join(mkdtempSync(path.join(tmpdir(), 'nvk-tk-c-')), 't.jsonl')), humans: [{ token: 't', personId: 'user_chris' as PersonId }] }),
  MessagingError,
  'malformed personId fails construction');
assert.throws(
  () => createNovakaiAuthority(validModel, clock, {} as never),
  MessagingError,
  'a missing token store fails construction (D-N6-2: no store, no agent credentials)');
console.log('config validation tests passed');

// --- session pruning (N1 audit finding 5) --------------------------------------------

const pruneModel = new ObjectModel({ storesDir: scratchStores() });
const pruneTeam = pruneModel.createTeam({ name: 'Prune Crew', missionId: 'mission_alpha' });
const pruneAgent = pruneModel.createAgent({ name: 'worker-prune', provider: 'kimi', teamId: pruneTeam, missionId: 'mission_alpha' });
const pruneTokens = createTokenStore(path.join(mkdtempSync(path.join(tmpdir(), 'nvk-tk-prune-')), 'tokens.jsonl'));
const prunable = createNovakaiAuthority(pruneModel, clock, { sessionTtlMs: 20, tokenStore: pruneTokens });
const pruneToken = pruneTokens.issue(pruneAgent).token;
const first = await prunable.authenticate({ token: pruneToken });
assert.equal(first.kind, 'authenticated');
assert.equal(prunable.sessionCount(), 1);
await new Promise((resolve) => setTimeout(resolve, 30)); // let the first session expire
const second = await prunable.authenticate({ token: pruneToken });
assert.equal(second.kind, 'authenticated');
assert.equal(prunable.sessionCount(), 1, 'the expired session is pruned at the next authenticate (finding 5)');
if (first.kind === 'authenticated') {
  assert.equal((await prunable.revalidate(first.principal.sessionId)).kind, 'invalid');
  assert.equal(prunable.sessionCount(), 1, 'revalidate deletes the expired entry at the point of truth');
}
console.log('session pruning tests passed');

// --- D-N8-1: external principals authenticate as THEMSELVES (person_ext-*) -----

const n8Model = new ObjectModel({ storesDir: scratchStores() }); // fresh — the G6 section deleted the main scratch
const externalsStore = createExternalsStore(path.join(mkdtempSync(path.join(tmpdir(), 'nvk-mv2-ext-')), 'externals.jsonl'));
const partner = externalsStore.provision({ slackUserId: 'U_PARTNER', displayName: 'Partner Chris' });
const n8Authority = createNovakaiAuthority(n8Model, clock, {
  humans: [{ token: 'human-secret', personId: 'person_user-chris' as PersonId, roles: ['Human'] }],
  tokenStore: tokens,
  externalsStore,
});
const partnerToken = tokens.issueExternal(partner.personId).token;

const partnerAuth = await n8Authority.authenticate({ token: partnerToken });
assert.equal(partnerAuth.kind, 'authenticated', 'an external token authenticates');
if (partnerAuth.kind !== 'authenticated') throw new Error('unreachable');
assert.equal(partnerAuth.principal.personId, partner.personId, 'the external is THEMSELVES — never an agent, never the human');
assert.deepEqual(partnerAuth.principal.grants, [], 'externals hold NO grants');

externalsStore.revokeBySlackUser('U_PARTNER');
assert.equal((await n8Authority.authenticate({ token: partnerToken })).kind, 'rejected', 'a revoked external → NotAuthenticated');
if (partnerAuth.kind === 'authenticated') {
  assert.equal((await n8Authority.revalidate(partnerAuth.principal.sessionId)).kind, 'invalid', 'revalidate re-checks revocation (§2.1)');
}
assert.equal(await n8Authority.isProvisioned(partner.personId as PersonId), false, 'revoked external is not provisioned');

const restored = externalsStore.provision({ slackUserId: 'U_PARTNER', displayName: 'Partner Chris' });
assert.equal(await n8Authority.isProvisioned(restored.personId as PersonId), true, 'active externals are provisioned (MSG-014)');

// An authority with NO externals store rejects external tokens (no truth to check).
const bare = createNovakaiAuthority(n8Model, clock, { tokenStore: tokens });
assert.equal((await bare.authenticate({ token: partnerToken })).kind, 'rejected', 'no externals store → external tokens rejected');
console.log('D-N8-1 external authority tests passed');

console.log('messagingV2 authority adapter tests passed');
