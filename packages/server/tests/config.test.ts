// B1a slice 1 — config capability (DEC-B1-3, §13 disposition 6).
// Tests cross the PUBLIC contract (openConfigStore) only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { openConfigStore } from '../contract/index.js';

const root = () => mkdtempSync(path.join(tmpdir(), 'nvk-server-config-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const serverCli = path.resolve(here, '..', 'cli', 'nvk-server.ts');

function runServerCli(dir: string, args: string[]): string {
  return execFileSync('npx', ['tsx', serverCli, ...args, '--root', dir], {
    cwd: path.resolve(here, '..'),
    encoding: 'utf8',
  });
}

test('first boot with no config.jsonl materializes defaults with ZERO principals (no demo defaults)', async () => {
  const dir = root();
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const cfg = opened.value.current();
  assert.deepEqual(cfg.principals, [], 'first boot must have EMPTY principals');
  assert.deepEqual(cfg.bindings, []);
  assert.equal(cfg.dev.allowMock, false, 'mock provider is off unless the operator turns it on');
  assert.equal(cfg.transcript.ingest, false,
    'fresh instances never ingest until the operator enables transcript.ingest');
  assert.equal(cfg.supervision.usageIntervalSec, 300);
  assert.equal(cfg.supervision.driftIntervalSec, 300);
  assert.ok(cfg.providers.kimi, 'provider settings materialize for kimi');
  assert.equal(cfg.providers.kimi.defaultModel, 'cli-default', 'never invent a model name (red gate 3)');

  assert.ok(existsSync(path.join(dir, 'stores', 'config.jsonl')), 'materialization writes the store file');
  const lines = readFileSync(path.join(dir, 'stores', 'config.jsonl'), 'utf8').trim().split('\n');
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

  const raw = readFileSync(path.join(dir, 'stores', 'config.jsonl'), 'utf8');
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

test('transcript.ingest is a dedicated config authority and round-trips independently of dev config', async () => {
  const dir = root();
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const store = opened.value;

  const enabled = await store.set(
    { configKind: 'transcript', ingest: true },
    mintClientOpId(),
  );
  assert.equal(enabled.ok, true);
  assert.equal(store.current().transcript.ingest, true);

  await store.set(
    { configKind: 'dev', allowMock: true, watchTranscripts: false },
    mintClientOpId(),
  );
  assert.equal(
    store.current().transcript.ingest,
    true,
    'legacy dev input cannot override the dedicated transcript authority',
  );

  const reopened = await openConfigStore({
    root: dir,
    principal: 'sys_spine',
  });
  assert.equal(reopened.ok, true);
  assert.equal(
    reopened.ok ? reopened.value.current().transcript.ingest : null,
    true,
  );
});

test('config-set writes through the server config engine and a live store reloads without restart', async () => {
  const dir = root();
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const watcher = opened.value.watch();

  const output = runServerCli(dir, ['config-set', 'dev', JSON.stringify({ allowMock: true })]);
  assert.match(output, /cfg_dev/);

  const deadline = Date.now() + 2_000;
  while (!opened.value.current().dev.allowMock && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(opened.value.current().dev.allowMock, true,
    'the already-open store observed the CLI edit through its file watcher');
  watcher.close();
});
