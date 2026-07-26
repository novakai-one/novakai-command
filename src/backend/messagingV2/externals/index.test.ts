/**
 * Externals store tests (D-N8-1): durable external principals — humans
 * OUTSIDE the workspace (PartnerChris) who hold their own personId, so a
 * Slack reply can land in the app AS THEM. Follows the tokens module's
 * store conventions (append-only, supersede-by-id, chmod 600). Run with
 * `npx tsx src/backend/messagingV2/externals/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { idPatterns } from '../../../../packages/messaging/public/contract/index.js';
import { createExternalsStore } from './index.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-externals-'));
const storePath = path.join(scratch, 'externals.jsonl');
const PERSON_PATTERN = new RegExp(idPatterns.PersonId);

const store = createExternalsStore(storePath);

// --- add: personId minted from the display name, durable record, 600 perms ----

const partner = store.provision({ slackUserId: 'U_PARTNER', displayName: 'Partner Chris' });
assert.equal(partner.kind, 'external-principal');
assert.equal(partner.schemaVersion, 1);
assert.ok(PERSON_PATTERN.test(partner.personId), `minted personId ${partner.personId} matches the contract pattern`);
assert.ok(partner.personId.startsWith('person_ext-'), 'external personIds are their own kind (never confused with agents)');
assert.equal(partner.slackUserId, 'U_PARTNER');
assert.equal(partner.displayName, 'Partner Chris');
assert.equal(statSync(storePath).mode & 0o777, 0o600, 'the store file is owner-only');
assert.equal(store.isActive(partner.personId), true, 'a fresh external is active');
assert.equal(store.recordForSlackUser('U_PARTNER')?.personId, partner.personId, 'slack user id resolves to the principal');
console.log('add tests passed');

// --- list + activePersonIds ------------------------------------------------

const second = store.provision({ slackUserId: 'U_MATE2', displayName: 'Mate Two' });
assert.deepEqual(store.activePersonIds().sort(), [partner.personId, second.personId].sort(), 'active list covers both');
assert.equal(store.list().length, 2);
console.log('list tests passed');

// --- revoke: active checks die, a second instance sees it (fresh fold) --------

const revoked = store.revokeBySlackUser('U_PARTNER');
assert.equal(revoked.length, 1, 'one external revoked');
assert.equal(store.isActive(partner.personId), false, 'a revoked external is not active');
assert.equal(store.list().find((record) => record.slackUserId === 'U_PARTNER')?.revoked, true, 'the listing shows the revoked marker');
assert.ok(!store.activePersonIds().includes(partner.personId), 'revoked leaves the active list');
const otherView = createExternalsStore(storePath);
assert.equal(otherView.isActive(partner.personId), false, 'a revocation is visible to another process');
assert.equal(otherView.isActive(second.personId), true, 'the other external stays active');
console.log('revoke tests passed');

// --- idempotent re-add after revoke: a FRESH record (new personId lineage) ----

const reAdded = store.provision({ slackUserId: 'U_PARTNER', displayName: 'Partner Chris' });
assert.notEqual(reAdded.id, partner.id, 're-add mints a new record, never resurrects the revoked one');
assert.equal(store.isActive(reAdded.personId), true, 'the re-added external is active again');
console.log('re-add tests passed');

rmSync(scratch, { recursive: true, force: true });
console.log('externals store tests passed');
