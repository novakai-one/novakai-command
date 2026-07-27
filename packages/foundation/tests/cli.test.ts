// FND-007 CLI parity: every contract op in-process AND via nvk-store, identical
// typed outcomes. Token mint (§11 ruling 1), bearer auth (R3-5/R3-6).
// Concurrency (R3-2): two processes contend on .novakai/lock → LockBusy/CAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeHandle, createObject, updateObject, getObject, listObjects, resolveRef,
  queryTraceBound, listQuarantineBound, resolveQuarantine, composeEngine,
  mintClientOpId, isAbsent,
  type ClientOpId, type ObjectId, type ScopedStoreHandle,
} from '../contract/index.js';
import { mintToken } from '../core/token.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/nvk-store.js');
const freshRoot = () => mkdtempSync(path.join(tmpdir(), 'nvk-fnd-'));

interface CliOut { ok: boolean; value?: never; error?: { code: string } }

function cli(root: string, token: string, args: string[]): CliOut {
  const res = spawnSync(process.execPath, [CLI, ...args, '--root', root, '--token', token], { encoding: 'utf8' });
  const line = res.stdout.trim().split('\n')[0] ?? '';
  try {
    return JSON.parse(line) as CliOut;
  } catch {
    throw new Error(`CLI produced no JSON (exit ${res.status}): ${res.stderr}\n${res.stdout}`);
  }
}

function mintCli(root: string, principal: string, grants: string[]): string {
  const res = spawnSync(process.execPath, [
    CLI, 'token', 'mint', '--principal', principal, '--grants', grants.join(','), '--root', root,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(res.stdout.trim()) as { ok: boolean; value: { bearer: string } };
  assert.equal(parsed.ok, true, `mint failed: ${res.stdout} ${res.stderr}`);
  return parsed.value.bearer;
}

const settingsPayload = (id: string) => ({
  kind: 'settings', id, schemaVersion: 1, createdAt: new Date().toISOString(),
  permissionLevel: 'private', createdBy: 'agent_cli', key: id, value: 1,
});

test('CLI: token mint writes one enveloped token record; bearer auth gates every op', async () => {
  const root = freshRoot();
  try {
    const bearer = mintCli(root, 'agent_cli', ['settings']);
    // token record is an enveloped object under .novakai/tokens/ (R3-5)
    const dir = path.join(root, 'tokens');
    const file = readdirSync(dir)[0];
    assert.ok(readFileSync(path.join(dir, file), 'utf8').includes('"kind": "token"'));
    // no token → exit 2
    const denied = spawnSync(process.execPath, [CLI, 'list', '--kind', 'settings', '--root', root], { encoding: 'utf8' });
    assert.equal(denied.status, 2);
    // wrong token → AuthFailed typed error
    const wrong = cli(root, 'nvk_wrong', ['list', '--kind', 'settings']);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error?.code, 'AuthFailed');
    void bearer;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FND-007 parity: create/get/list/update/resolve-ref identical in-process and via CLI', async () => {
  const root = freshRoot();
  try {
    const bearer = mintCli(root, 'agent_cli', ['settings']);
    const copA = mintClientOpId();
    const copB = mintClientOpId();

    // in-process create (settings_one) vs CLI create (settings_two)
    const h = composeHandle({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'agent_cli' });
    const inProc = await createObject(h, settingsPayload('settings_one'), copA);
    assert.equal(inProc.ok, true);
    const viaCli = cli(root, bearer, ['create', '--data', JSON.stringify(settingsPayload('settings_two')), '--client-op-id', copB]);
    assert.equal(viaCli.ok, true);

    // same typed outcome shape both paths
    if (inProc.ok) {
      assert.equal(inProc.value.object.createdBy, 'agent_cli');
      assert.equal((viaCli.value as unknown as { object: { createdBy: string } }).object.createdBy, 'agent_cli');
      assert.equal(inProc.value.version, (viaCli.value as unknown as { version: number }).version);
    }

    // get both ways → same object
    const getInProc = await getObject(h, 'settings', 'settings_two' as ObjectId);
    const getCli = cli(root, bearer, ['get', '--kind', 'settings', '--id', 'settings_two']);
    assert.equal(getCli.ok, true);
    if (getInProc.ok && !isAbsent(getInProc.value)) {
      assert.deepEqual(
        (getCli.value as unknown as { object: unknown }).object,
        getInProc.value.object,
      );
    } else {
      assert.fail('CLI-created object must be visible in-process');
    }

    // list parity
    const listInProc = await listObjects(h, 'settings');
    const listCli = cli(root, bearer, ['list', '--kind', 'settings']);
    assert.equal(listCli.ok, true);
    if (listInProc.ok) {
      const cliIds = (listCli.value as unknown as { items: { object: { id: string } }[] }).items.map((i) => i.object.id).sort();
      assert.deepEqual(cliIds, listInProc.value.items.map((i) => i.object.id).sort());
    }

    // update via CLI; CAS conflict typed identically
    const upd = cli(root, bearer, ['update', '--id', 'settings_one', '--patch', JSON.stringify({ value: 2 }), '--expected-version', '1', '--client-op-id', mintClientOpId()]);
    assert.equal(upd.ok, true);
    const conflict = cli(root, bearer, ['update', '--id', 'settings_one', '--patch', JSON.stringify({ value: 3 }), '--expected-version', '1', '--client-op-id', mintClientOpId()]);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error?.code, 'CasConflict');

    // resolve-ref parity: absent both ways
    const refInProc = await resolveRef(h, { kind: 'settings', id: 'settings_ghost' });
    const refCli = cli(root, bearer, ['resolve-ref', '--kind', 'settings', '--id', 'settings_ghost']);
    assert.equal(refCli.ok, true);
    if (refInProc.ok) {
      assert.deepEqual(refCli.value, refInProc.value);
    }

    // scope: token granted only settings → agent write = ScopeViolation via CLI too
    const scoped = cli(root, bearer, ['create', '--data', JSON.stringify({
      kind: 'agent', id: 'agent_x', schemaVersion: 1, createdAt: new Date().toISOString(),
      permissionLevel: 'team', createdBy: 'agent_cli', displayName: 'X', provider: 'mock', model: 'm',
    }), '--client-op-id', mintClientOpId()]);
    assert.equal(scoped.ok, false);
    assert.equal(scoped.error?.code, 'ScopeViolation');

    // trace query parity: the engine sees CLI mutations' traces
    const engine = composeEngine({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'agent_cli' });
    const traces = await queryTraceBound(engine, { target: { kind: 'settings', id: 'settings_one' } });
    assert.equal(traces.items.length, 2); // create + CLI update
    assert.ok(traces.items.every((t) => t.createdBy === 'agent_cli'));

    // quarantine verbs round-trip
    const quarantine = await listQuarantineBound(engine);
    const quarantineCli = cli(root, bearer, ['quarantine', 'list']);
    assert.equal(quarantineCli.ok, true);
    assert.deepEqual(quarantineCli.value, quarantine);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrency: two processes, one lock — second writer gets LockBusy, never blocks forever', { timeout: 20000 }, async () => {
  const root = freshRoot();
  try {
    const bearer = mintCli(root, 'agent_cli', ['settings']);
    // hold the lock from this process
    const { acquireLock } = await import('../core/store-engine/lock.js');
    const lock = acquireLock(root, { timeoutMs: 1000 });
    try {
      const start = Date.now();
      const res = cli(root, bearer, ['create', '--data', JSON.stringify(settingsPayload('settings_x')), '--client-op-id', mintClientOpId()]);
      const waited = Date.now() - start;
      assert.equal(res.ok, false);
      assert.equal(res.error?.code, 'LockBusy');
      assert.ok(waited >= 4500 && waited < 8000, `bounded wait ~5s, got ${waited}ms`);
    } finally {
      const { releaseLock } = await import('../core/store-engine/lock.js');
      releaseLock(lock);
    }
    // after release the same op succeeds
    const res = cli(root, bearer, ['create', '--data', JSON.stringify(settingsPayload('settings_x')), '--client-op-id', mintClientOpId()]);
    assert.equal(res.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrency: dead lock holder is taken over (pid-liveness), live holder never broken', async () => {
  const root = freshRoot();
  try {
    // plant a lock owned by a dead pid
    const lockDir = path.join(root, 'lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999, token: 'dead' }) + '\n');
    const bearer = mintCli(root, 'agent_cli', ['settings']);
    const res = cli(root, bearer, ['create', '--data', JSON.stringify(settingsPayload('settings_y')), '--client-op-id', mintClientOpId()]);
    assert.equal(res.ok, true); // takeover worked
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveQuarantine via CLI (parity on the human resolution path)', async () => {
  const root = freshRoot();
  try {
    mkdirSync(root, { recursive: true });
    // plant orphan + boot to tombstone it
    appendFileSync(path.join(root, 'settings.jsonl'), JSON.stringify({
      envelope: {
        kind: 'settings', id: 'settings_orphan', schemaVersion: 1,
        createdAt: new Date().toISOString(), permissionLevel: 'private', createdBy: 'agent_cli',
      },
      payload: { key: 'k', value: 1 },
      meta: { opId: 'srv_orphan', clientOpId: 'op_orphan', version: 1 },
    }) + '\n');
    const engine = composeEngine({ root, capability: 'foundation', allowedKinds: ['settings'], principal: 'agent_cli' });
    engine.boot();
    const quarantine = await listQuarantineBound(engine);
    const tombstone = quarantine.items.find((t) => t.quarantinedRef.id === 'settings_orphan');
    assert.ok(tombstone);
    const bearer = mintCli(root, 'agent_cli', ['settings', 'quarantine']);
    const res = cli(root, bearer, ['quarantine', 'resolve', '--id', tombstone.id, '--resolution', 'reconcile', '--client-op-id', mintClientOpId()]);
    assert.equal(res.ok, true);
    assert.equal((res.value as unknown as { status: string }).status, 'resolved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
