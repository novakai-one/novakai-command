// B1a slice 1 — config capability (DEC-B1-3, §13 disposition 6).
// Tests cross the PUBLIC contract (openConfigStore) only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { openConfigStore } from '../contract/index.js';

const root = () => mkdtempSync(path.join(tmpdir(), 'nvk-server-config-'));

test('first boot with no config.jsonl materializes defaults with ZERO principals (no demo defaults)', async () => {
  const dir = root();
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const cfg = opened.value.current();
  assert.deepEqual(cfg.principals, [], 'first boot must have EMPTY principals');
  assert.deepEqual(cfg.bindings, []);
  assert.equal(cfg.dev.allowMock, false, 'mock provider is off unless the operator turns it on');
  assert.equal(cfg.dev.watchTranscripts, false,
    'transcript watchers are off until they stop starving the HTTP loop (B1b/S3)');
  assert.equal(cfg.supervision.usageIntervalSec, 300);
  assert.equal(cfg.supervision.driftIntervalSec, 300);
  assert.ok(cfg.providers.kimi, 'provider settings materialize for kimi');
  assert.equal(cfg.providers.kimi.defaultModel, 'cli-default', 'never invent a model name (red gate 3)');

  assert.ok(existsSync(path.join(dir, 'config.jsonl')), 'materialization writes the store file');
  const lines = readFileSync(path.join(dir, 'config.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const rec = JSON.parse(line) as { envelope: { kind: string }; payload: { configKind: string } };
    assert.equal(rec.envelope.kind, 'config');
    assert.notEqual(rec.payload.configKind, 'principal', 'first boot writes NO principal objects');
  }
});

test('a principal config object resolves to a bearer principal through its token record', async () => {
  const dir = root();
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const store = opened.value;

  // Tokens are foundation records; config carries only the REFERENCE (red gate 1).
  const minted = store.mintPrincipalToken({ personId: 'person_chris', roles: ['Human'], grants: ['message.send'] });
  const set = await store.set(
    { configKind: 'principal', personId: 'person_chris', roles: ['Human'], tokenId: minted.id },
    mintClientOpId(),
  );
  assert.equal(set.ok, true);

  const cfg = store.current();
  assert.equal(cfg.principals.length, 1);
  assert.equal(cfg.principals[0]!.personId, 'person_chris');
  assert.equal(cfg.principals[0]!.token, minted.bearer, 'bearer comes from the token record, never from config');
  assert.deepEqual(cfg.principals[0]!.roles, ['Human']);

  const raw = readFileSync(path.join(dir, 'config.jsonl'), 'utf8');
  assert.equal(raw.includes(minted.bearer), false, 'the bearer secret never lands in config.jsonl');
});

test('a principal whose token record is missing is drawn absence: unresolved, not a crash (DEC-F2)', async () => {
  const dir = root();
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const store = opened.value;

  await store.set(
    { configKind: 'principal', personId: 'person_ghost', roles: ['Worker'], tokenId: 'token_does_not_exist' },
    mintClientOpId(),
  );
  const cfg = store.current();
  assert.deepEqual(cfg.principals, []);
  assert.equal(cfg.unresolvedPrincipals.length, 1);
  assert.equal(cfg.unresolvedPrincipals[0]!.personId, 'person_ghost');
  assert.match(cfg.unresolvedPrincipals[0]!.reason, /token/i);
});

test('latest line wins per config key (§13 disposition 6) and survives reopen', async () => {
  const dir = root();
  const first = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  await first.value.set({ configKind: 'supervision', usageIntervalSec: 420 }, mintClientOpId());
  assert.equal(first.value.current().supervision.usageIntervalSec, 420);
  await first.value.set({ configKind: 'supervision', usageIntervalSec: 600 }, mintClientOpId());
  assert.equal(first.value.current().supervision.usageIntervalSec, 600);
  assert.equal(first.value.current().supervision.driftIntervalSec, 300, 'unset fields keep their defaults');

  const second = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.current().supervision.usageIntervalSec, 600, 'reopen resolves the latest line');
});

test('agent-person bindings and provider settings round-trip through the config store', async () => {
  const dir = root();
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const store = opened.value;

  await store.set({ configKind: 'agentPersonBinding', agentId: 'agent_a', personId: 'person_a' }, mintClientOpId());
  await store.set({ configKind: 'provider', provider: 'kimi', cliPath: '/tmp/kimi', defaultModel: 'cli-default' }, mintClientOpId());
  await store.set({ configKind: 'dev', allowMock: true }, mintClientOpId());

  const cfg = store.current();
  assert.deepEqual(cfg.bindings, [{ agentId: 'agent_a', personId: 'person_a' }]);
  assert.equal(cfg.providers.kimi.cliPath, '/tmp/kimi');
  assert.equal(cfg.dev.allowMock, true);
});
