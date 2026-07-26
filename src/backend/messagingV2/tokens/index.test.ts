/**
 * Agent-token store tests (D-N6-2): durable issuance/revocation for external
 * (and in-process) messaging credentials. Hash-only at rest, one raw print
 * at issuance, cross-process fold freshness (the CLI is a second process).
 * Run with `npx tsx src/backend/messagingV2/tokens/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTokenStore } from './index.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-tokens-'));
const storePath = path.join(scratch, 'tokens.jsonl');
const store = createTokenStore(storePath);

// --- issue: format, persistence, hash-only at rest, mode 600 -------------------

const first = store.issue('agent_alpha');
assert.match(first.token, /^nvkt_[0-9a-f]{64}$/, 'token is nvkt_<64 hex> (256-bit)');
assert.equal(first.record.agentId, 'agent_alpha');
assert.equal(first.record.kind, 'agent-token');
assert.equal(first.record.schemaVersion, 1);
assert.ok(existsSync(storePath), 'the store file is created on first issue');
assert.equal(statSync(storePath).mode & 0o777, 0o600, 'the store file is owner-only (chmod 600)');
const atRest = readFileSync(storePath, 'utf8');
assert.ok(!atRest.includes(first.token), 'the RAW token appears NOWHERE at rest');
assert.ok(atRest.includes(first.record.tokenHash), 'only the SHA-256 hash persists');
assert.equal(store.tokenForAgent('agent_alpha'), first.token, 'the in-process raw is held for consumers');
console.log('issue tests passed');

// --- ensure: zero-touch idempotence for boot/launch mints ----------------------

const linesBefore = atRest.trim().split('\n').length;
store.ensure('agent_alpha');
store.ensure('agent_alpha');
const linesAfter = readFileSync(storePath, 'utf8').trim().split('\n').length;
assert.equal(linesAfter, linesBefore, 'ensure with a held in-process raw mints NOTHING');
store.ensure('agent_beta');
assert.match(store.tokenForAgent('agent_beta') ?? '', /^nvkt_/, 'ensure mints for a new agent');
console.log('ensure tests passed');

// --- resolve: hash lookup, unknown rejected ------------------------------------

const resolved = store.resolve(first.token);
assert.deepEqual(resolved, { agentId: 'agent_alpha', recordId: first.record.id }, 'a live token resolves to its agent + record');
assert.equal(store.resolve('nvkt_0000000000000000000000000000000000000000000000000000000000000000'), null, 'an unknown token resolves null');
assert.equal(store.resolve('agent_alpha'), null, 'a raw agentId is NEVER a credential (D-N2-2 retired)');
console.log('resolve tests passed');

// --- cross-process freshness: a second instance sees CLI-side appends ----------

const otherInstance = createTokenStore(storePath);
const fromOther = otherInstance.issue('agent_gamma');
assert.deepEqual(
  store.resolve(fromOther.token),
  { agentId: 'agent_gamma', recordId: fromOther.record.id },
  'a token issued by ANOTHER process resolves here (fresh fold on miss)',
);
console.log('cross-process freshness tests passed');

// --- revoke: resolution dies, listing stays honest, ids never carry the token ---

const revoked = store.revokeAll('agent_alpha');
assert.equal(revoked.length, 1, 'one live token revoked');
assert.equal(store.resolve(first.token), null, 'a revoked token resolves null');
assert.equal(store.isRevoked(first.record.id), true, 'the revocation is visible by record id (revalidate)');
const listed = store.listFor('agent_alpha');
assert.equal(listed.length, 1);
assert.equal(listed[0]?.revoked, true, 'the listing shows the revoked marker');
assert.ok(!JSON.stringify(listed).includes(first.token), 'listings NEVER carry the raw token');
const otherView = createTokenStore(storePath);
assert.equal(otherView.resolve(first.token), null, 'a revocation by another process is visible here');
console.log('revoke tests passed');

// --- a fresh instance on the same file folds history (restart truth) ------------

const restarted = createTokenStore(storePath);
assert.equal(restarted.tokenForAgent('agent_beta'), null, 'raw tokens never survive a restart (hash-only at rest)');
assert.ok(restarted.resolve(store.tokenForAgent('agent_beta') ?? '') !== null, 'but the beta token still authenticates by hash');
assert.equal(restarted.listFor('agent_alpha').length, 1, 'history folds across restart');

rmSync(scratch, { recursive: true, force: true });
console.log('token store tests passed');
