// B3e lane A slice A0 — the boot path, RED-first.
//
// Three findings the browse-harness seat reproduced on the sealed tip
// (B3E-ENTRY-LIST E-01/E-02/E-03). Every one of them is a *restart determinism*
// defect, which is the property Build 3 exists to guarantee, so each gets a
// test that fails for the real reason before it gets a fix.
//
//   E-01  a fresh data root boots `nvk-server` exactly ONCE. The first boot
//         writes a legacy-route `traces.jsonl` beside the canonical one, and
//         the §18.1 route gate then refuses every later boot with
//         StoreRouteConflict. An exam row needing a backed Shell scores once
//         and goes BLIND on every retry.
//   E-02  no explicit port meant port 5180 — Chris's LIVE server port. A dev
//         or harness boot could seize it.
//   E-03  the watchdog registry was written into the product checkout, so a
//         throwaway data root still left a mark on the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mintClientOpId, surveyStoreRoute,
} from '@novakai/foundation/dist/contract/index.js';
import { bootServer } from '../../core/boot.js';
import { openConfigStore } from '../../contract/index.js';
import { LIVE_SERVER_PORT, resolveServerLaunch } from '../../core/launch-options.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-server.ts');

const freshRoot = (): string => mkdtempSync(path.join(tmpdir(), 'nvk-b3e-boot-'));
const canonical = (root: string): string => path.join(root, 'stores');

/** The §13 disposition 4 cold-start runbook — the same one an operator runs. */
async function mintChris(root: string): Promise<void> {
  const opened = await openConfigStore({ root, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const token = opened.value.mintPrincipalToken({
    personId: 'person_chris', roles: ['Human'], grants: ['layout', 'settings', 'conversationView'],
  });
  await opened.value.set(
    { configKind: 'principal', personId: 'person_chris', roles: ['Human'], tokenId: token.id },
    mintClientOpId(),
  );
}

interface BootAttempt { readonly ready: boolean; readonly log: string }

/**
 * One real `nvk-server` process on an OS-assigned port, killed once it says it
 * is ready. A child process is the only honest form of this test: the route
 * gate memoises per root inside a process, so a second in-process boot would
 * skip the very check E-01 is about.
 */
function bootOnce(root: string, staticDir: string): Promise<BootAttempt> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [tsxCli, serverCli, '--root', root, '--port', '0', '--static', staticDir],
      { cwd: repoRoot, env: { ...process.env, NOVAKAI_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    let ready = false;
    const read = (chunk: Buffer): void => {
      log += chunk.toString();
      if (!ready && log.includes('[nvk-server] ready')) {
        ready = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    // Resolving on exit (not on the ready line) is what keeps the second boot
    // honest: the port and the OS lock are released before it starts.
    child.on('error', (cause) => { log += `\nspawn failed: ${cause.message}`; resolve({ ready, log }); });
    child.on('exit', (code, signal) => resolve({ ready, log: `${log}\n[exit ${code} ${signal}]` }));
  });
}

// ── E-01 ──────────────────────────────────────────────────────────────────

test('a boot writes nothing on the legacy route', async () => {
  const root = freshRoot();
  await mintChris(root);

  const booted = await bootServer({ root, port: 0, cwd: root, watchdogDir: root });
  assert.equal(booted.ok, true, `boot failed: ${booted.ok ? '' : booted.error.message}`);
  if (!booted.ok) return;
  await booted.value.close();

  // This is the whole of E-01's cause. A boot that writes ANY registered kind
  // beside the canonical directory has created a second route under the same
  // root. `migratable` is checked too: a legacy-route file is a file this
  // composition should never have created.
  const survey = surveyStoreRoute({ dataRoot: canonical(root), legacyRoot: root });
  assert.deepEqual([...survey.conflicting], [], 'a boot must not write a registered kind on the legacy route');
  assert.deepEqual([...survey.migratable], [], 'a boot must not leave a legacy-route file behind');
});

test('a fresh data root boots nvk-server twice', { timeout: 300_000 }, async () => {
  const root = freshRoot();
  const staticDir = freshRoot();
  await mintChris(root);

  const first = await bootOnce(root, staticDir);
  assert.equal(first.ready, true, `first boot never became ready:\n${first.log}`);

  const second = await bootOnce(root, staticDir);
  assert.equal(second.ready, true, `second boot on the same root failed:\n${second.log}`);
});

// ── E-02: the port law ────────────────────────────────────────────────────

const launch = (argv: readonly string[], env: NodeJS.ProcessEnv = {}) =>
  resolveServerLaunch({ argv: ['node', 'nvk-server.ts', ...argv], env, repoRoot });

test('--port is honoured', () => {
  const resolved = launch(['--port', '5194']);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.value.port, 5194);
});

test('NOVAKAI_PORT is honoured, and the flag beats it', () => {
  const fromEnv = launch([], { NOVAKAI_PORT: '5194' });
  assert.equal(fromEnv.ok, true);
  if (fromEnv.ok) assert.equal(fromEnv.value.port, 5194);

  const fromFlag = launch(['--port', '5195'], { NOVAKAI_PORT: '5194' });
  assert.equal(fromFlag.ok, true);
  if (fromFlag.ok) assert.equal(fromFlag.value.port, 5195);
});

test('port 0 is a choice — the OS assigns one', () => {
  const resolved = launch(['--port', '0']);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.value.port, 0);
});

test('no port anywhere is a refusal, never the live port', () => {
  for (const env of [{}, { NOVAKAI_ROOT: '/tmp/x' }, { NOVAKAI_SERVER_PORT: '3131' }]) {
    const resolved = launch([], env);
    assert.equal(resolved.ok, false, `an unstated port must never resolve: ${JSON.stringify(env)}`);
    if (resolved.ok) continue;
    assert.equal(resolved.error.code, 'PortNotChosen');
    assert.doesNotMatch(resolved.error.message, /listening|ready/);
  }
});

test('NOVAKAI_SERVER_PORT alone is refused by name', () => {
  // The exact trap the harness seat fell into: that variable belongs to the
  // root vite lane, so honouring it silently would put this server on the
  // legacy backend's port — and ignoring it silently put it on 5180.
  const resolved = launch([], { NOVAKAI_SERVER_PORT: '5194' });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.error.message, /NOVAKAI_SERVER_PORT/);
  assert.match(resolved.error.message, /NOVAKAI_PORT/);
});

test('the live port is never a default, only an explicit choice', () => {
  assert.equal(launch([], {}).ok, false, `nothing may resolve to ${LIVE_SERVER_PORT} on its own`);

  const chosen = launch(['--port', String(LIVE_SERVER_PORT)]);
  assert.equal(chosen.ok, true, 'an operator who names the live port gets it');
  if (chosen.ok) assert.equal(chosen.value.port, LIVE_SERVER_PORT);
});

test('an unusable port is a refusal', () => {
  for (const bad of ['nonsense', '-1', '70000', '5194.5', '']) {
    const resolved = launch(['--port', bad]);
    assert.equal(resolved.ok, false, `"${bad}" must not resolve`);
    if (!resolved.ok) assert.equal(resolved.error.code, 'PortInvalid');
  }
});

// ── E-03: nothing escapes the sandbox ─────────────────────────────────────

test('the watchdog registry lives under the data root, not the checkout', () => {
  const root = freshRoot();
  const resolved = launch(['--port', '0', '--root', root]);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.value.watchdogDir, root);
  assert.ok(!resolved.value.watchdogDir.startsWith(repoRoot), 'server state must not land in the product checkout');
});

test('every written path a throwaway root produces stays outside the checkout', () => {
  const root = freshRoot();
  const resolved = launch(['--port', '0'], { NOVAKAI_ROOT: root });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  for (const written of [resolved.value.root, resolved.value.watchdogDir]) {
    assert.ok(!path.resolve(written).startsWith(path.resolve(repoRoot) + path.sep),
      `${written} is inside the product checkout`);
  }
});

test('the watchdog directory is still overridable for an operator', () => {
  const root = freshRoot();
  const elsewhere = freshRoot();
  const byFlag = launch(['--port', '0', '--root', root, '--watchdog-dir', elsewhere]);
  assert.equal(byFlag.ok, true);
  if (byFlag.ok) assert.equal(byFlag.value.watchdogDir, elsewhere);

  const byEnv = launch(['--port', '0', '--root', root], { NOVAKAI_WATCHDOG_DIR: elsewhere });
  assert.equal(byEnv.ok, true);
  if (byEnv.ok) assert.equal(byEnv.value.watchdogDir, elsewhere);
});

test('a boot leaves the watchdog registry under its own root', async () => {
  const root = freshRoot();
  await mintChris(root);
  // `cwd` is the directory provider CLIs run in — the checkout, in production.
  // Defaulting the registry to it is exactly how state escaped the sandbox.
  const booted = await bootServer({ root, port: 0, cwd: repoRoot });
  assert.equal(booted.ok, true);
  if (!booted.ok) return;
  const registry = booted.value.steps.find((s) => s.name === 'supervision')?.detail ?? '';
  await booted.value.close();
  assert.ok(registry.includes(path.join(root, '.watchdog-sessions.json')),
    `the registry belongs under the data root, not the checkout: ${registry}`);
});
