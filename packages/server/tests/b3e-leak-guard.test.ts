// B3e lane A — P-01: the parallel `packages/server` suite hangs forever.
//
// The cause is not parallelism. This suite's cleanup lives on the HAPPY PATH —
// 129 in-body `close()` calls against 13 registered `t.after` hooks across 93
// files — so a test that fails BEFORE its close line leaks a listening server.
// The worker process then has a live handle and cannot exit; `node --test` runs
// with `--test-timeout=0` and waits on that worker for as long as the machine
// is up. Parallelism only pulls the trigger, because a saturated machine is
// where load-sensitive assertions fail. (Measured on this machine: an orphaned
// worker from an earlier SERIAL run, 4h51m old, PPID 1, still LISTENing.)
//
// `--test-force-exit` is not the fix. It stops the RUNNER waiting and leaves
// the leaking worker behind as an orphan still holding its port — a visible
// hang traded for a silent process leak. Test 4 below is the assertion that
// separates the two: the guard CLOSES what was left open.
//
// So the fix is a preloaded guard (`tests/support/no-leaked-handles.ts`) whose
// root `after()` closes any listening handle the file left open and then fails
// THAT FILE by name. This suite is the guard's own contract, driven through the
// same `tsx --import … --test` invocation `package.json` uses.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const GUARD = './tests/support/no-leaked-handles.ts';
const LEAKY = 'tests/support/fixtures/leaks-a-listener.fixture.ts';
const CLEAN = 'tests/support/fixtures/closes-its-listener.fixture.ts';

/**
 * A DEADLINE, not a sleep: the green path never waits on it. It exists because
 * the defect under test is an infinite wait — without it, a regression would
 * hang this suite instead of reporting, which is the very failure mode P-01 is
 * about. 90s is far outside a one-file run (~1s) even on a loaded machine.
 */
const DEADLINE_MS = 90_000;

interface RunResult {
  readonly code: number | null;
  readonly out: string;
  readonly timedOut: boolean;
}

function runGuarded(fixture: string, env: Readonly<Record<string, string>> = {}): Promise<RunResult> {
  // `NODE_TEST_CONTEXT` is how a worker knows it is reporting to a runner. This
  // test IS a worker, so inheriting it makes the runner we spawn believe it is
  // one too: it reports to a parent that is not listening and exits 0 without
  // running anything. Found the hard way.
  const inherited = { ...process.env, ...env };
  delete inherited['NODE_TEST_CONTEXT'];
  const child = spawn(
    process.execPath,
    [tsxCli, '--import', GUARD, '--test', fixture],
    { cwd: serverRoot, env: inherited },
  );
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); }, DEADLINE_MS);
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, out, timedOut: signal === 'SIGKILL' });
    });
  });
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { resolve(false); });
  });
}

test('a file that leaves a listener open is FAILED BY NAME, and the run ends on its own',
  async () => {
    const result = await runGuarded(LEAKY);
    assert.equal(result.timedOut, false,
      'the run must terminate on its own — this is P-01: it hung');
    assert.equal(result.code, 1, 'a leaked handle is a reported failure');
    assert.match(result.out, /outlived/,
      'the guard must say what happened');
    assert.match(result.out, /leaks-a-listener\.fixture\.ts/,
      'the failure must name the OFFENDING FILE, not the run');
  });

test('a file that registers its close is left alone', async () => {
  const result = await runGuarded(CLEAN);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0, `the guard bit an honest file:\n${result.out}`);
});

test('the leaked listener is CLOSED, not merely reported (what --test-force-exit cannot do)',
  async () => {
    const portFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'nvk-leak-guard-')), 'port');
    const result = await runGuarded(LEAKY, { NVK_LEAK_FIXTURE_PORT_FILE: portFile });
    assert.equal(result.timedOut, false);
    const port = Number(readFileSync(portFile, 'utf8'));
    assert.ok(Number.isInteger(port) && port > 0, 'the fixture must report the port it opened');
    assert.equal(await isListening(port), false,
      `port ${String(port)} is still held: the worker survived the run as an orphan`);
  });

test('the package test script preloads the guard', () => {
  const manifest: unknown = JSON.parse(readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
  const scripts = (manifest as { scripts?: Record<string, string> }).scripts ?? {};
  assert.match(scripts['test'] ?? '', /--import \.\/tests\/support\/no-leaked-handles\.ts/,
    'dropping the preload silently returns the suite to hanging forever');
});
