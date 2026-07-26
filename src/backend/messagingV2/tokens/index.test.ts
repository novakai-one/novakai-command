/**
 * Agent-token store tests (D-N6-2): durable issuance/revocation for external
 * (and in-process) messaging credentials. Hash-only at rest, one raw print
 * at issuance, cross-process fold freshness (the CLI is a second process).
 * Run with `npx tsx src/backend/messagingV2/tokens/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// --- F1: a SECOND process's revocation retires this process's held raw ---------
// The running server holds raws in memory; the CLI revokes from another
// process. A held raw whose records are ALL revoked is NOT a credential:
// ensure() must re-mint and tokenForAgent() must never serve the dead raw.

{
  const f1Dir = mkdtempSync(path.join(tmpdir(), 'nvk-tokens-f1-'));
  const f1Path = path.join(f1Dir, 'tokens.jsonl');
  const server = createTokenStore(f1Path);
  const cliStore = createTokenStore(f1Path);

  server.ensure('agent_remote');
  const deadRaw = server.tokenForAgent('agent_remote');
  assert.match(deadRaw ?? '', /^nvkt_/, 'the server holds a raw after ensure');
  cliStore.revokeAll('agent_remote'); // the owner's CLI, a second process
  assert.equal(cliStore.resolve(deadRaw ?? ''), null, 'sanity: the CLI process sees its own revocation');

  server.ensure('agent_remote');
  const freshRaw = server.tokenForAgent('agent_remote');
  assert.notEqual(freshRaw, deadRaw, 'after a cross-process revocation, ensure() MUST re-mint — the held raw is dead');
  assert.match(freshRaw ?? '', /^nvkt_/, 'the re-minted raw is served to consumers');
  assert.equal(server.resolve(deadRaw ?? ''), null, 'the dead raw never resolves again');
  assert.deepEqual(
    server.resolve(freshRaw ?? '')?.agentId,
    'agent_remote',
    'the re-minted token authenticates (the running server heals in place)',
  );
  rmSync(f1Dir, { recursive: true, force: true });
  console.log('F1 cross-process revocation tests passed');
}

// --- F3: a pre-existing loose file is tightened to 600 on the next append ------

{
  const f3Dir = mkdtempSync(path.join(tmpdir(), 'nvk-tokens-f3-'));
  const f3Path = path.join(f3Dir, 'tokens.jsonl');
  writeFileSync(f3Path, '', { mode: 0o644 }); // hand-created / umask-loose
  assert.equal(statSync(f3Path).mode & 0o777, 0o644, 'fixture: the file starts readable');
  const f3Store = createTokenStore(f3Path);
  f3Store.issue('agent_loose');
  assert.equal(statSync(f3Path).mode & 0o777, 0o600, 'an append tightens a loose pre-existing file to 600');
  rmSync(f3Dir, { recursive: true, force: true });
  console.log('F3 loose-file permission tests passed');
}

// --- D-N8-1: external tokens resolve to a personId directly ------------------

{
  const n8Dir = mkdtempSync(path.join(tmpdir(), 'nvk-tokens-n8-'));
  const n8Path = path.join(n8Dir, 'tokens.jsonl');
  const n8Store = createTokenStore(n8Path);

  const issued = n8Store.issueExternal('person_ext-partner-chris');
  assert.match(issued.token, /^nvkt_[0-9a-f]{64}$/, 'external tokens share the nvkt_ format');
  assert.equal(issued.record.externalPersonId, 'person_ext-partner-chris');
  assert.equal(issued.record.agentId, undefined, 'an external record carries NO agentId');
  assert.ok(!readFileSync(n8Path, 'utf8').includes(issued.token), 'the raw external token is never at rest');

  const resolved = n8Store.resolve(issued.token);
  assert.deepEqual(resolved, { recordId: issued.record.id, externalPersonId: 'person_ext-partner-chris' },
    'an external token resolves to its personId (no agentId)');
  assert.equal(n8Store.tokenForExternal('person_ext-partner-chris'), issued.token, 'in-process raw held');

  n8Store.ensureExternal('person_ext-partner-chris');
  assert.equal(n8Store.tokenForExternal('person_ext-partner-chris'), issued.token, 'ensure is idempotent');

  n8Store.revokeAllForExternal('person_ext-partner-chris');
  assert.equal(n8Store.resolve(issued.token), null, 'a revoked external token never resolves');
  assert.equal(n8Store.tokenForExternal('person_ext-partner-chris'), null, 'a held external raw dies on revocation');
  n8Store.ensureExternal('person_ext-partner-chris');
  assert.notEqual(n8Store.tokenForExternal('person_ext-partner-chris'), issued.token, 'ensure re-mints after revocation');

  rmSync(n8Dir, { recursive: true, force: true });
  console.log('D-N8-1 external token tests passed');
}
