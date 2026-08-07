// `nvk-runtime stop` actually stops the runtime (probe S-6, §13.1).
//
// The probe's terminal state: `stop --live-runs stop-explicitly` reported
// "Runtime stopped", the sessions really did stop — and the PROCESS did not.
// It kept the port, answered every subsequent request with 401, `doctor` (the
// tool that exists for exactly this) could not connect, `ensure --start` spawned
// a child that died instantly on EADDRINUSE, and the error said "not reachable,
// retryable" forever. The only way out was `kill -9` on a pid no CLI would name.
//
// Driven as a real child process, because the defect IS the process: nothing
// in-process can prove a serving host exits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const runtimeCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-runtime.ts');

/** A port nobody is using right now — asked for, not guessed. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const chosen = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => { resolve(chosen); });
    });
  });
}

function runCli(root: string, port: number, args: readonly string[]): Promise<string> {
  const child = spawn(
    process.execPath,
    [tsx, runtimeCli, ...args, '--root', root, '--port', String(port)],
    { cwd: repoRoot },
  );
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', () => { resolve(out); }); });
}

async function serve(root: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [tsx, runtimeCli, 'serve', '--root', root, '--port', String(port)],
    { cwd: repoRoot, detached: true },
  );
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the runtime never came up')), 40_000);
    let seen = '';
    child.stdout.on('data', (chunk) => {
      seen += String(chunk);
      if (seen.includes('background runtime ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

test('a stopped runtime lets go of its port instead of squatting on it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-stopexit-'));
  const port = await freePort();
  let child: ChildProcess | null = null;
  try {
    child = await serve(root, port);
    const ended = new Promise<void>((resolve) => { child!.on('exit', () => { resolve(); }); });

    const stopped = await runCli(root, port, ['stop', '--live-runs', 'stop-explicitly']);
    assert.equal(stopped.includes('Runtime stopped'), true,
      `stop did not report a stop: ${stopped}`);

    // The claim under test: "Runtime stopped" means the runtime stopped.
    const exited = await Promise.race([
      ended.then(() => true),
      new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, 10_000); }),
    ]);
    assert.equal(exited, true,
      'the runtime reported itself stopped and kept running, holding the port');

    // And the proof an operator would actually run: the port is usable again.
    const reopened = await serve(root, port);
    reopened.stdout?.destroy();
    process.kill(-reopened.pid!, 'SIGKILL');
  } finally {
    if (child?.pid !== undefined && child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
