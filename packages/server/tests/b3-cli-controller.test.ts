// Finding 4 (NVK-KIMI-021 SEVERE), the CLI half: `nvk-terminal attach` recorded
// an attachment and exited immediately, never detaching — so every scripted
// attach permanently inflated the controller count.
//
// The shape that makes that honest: attaching is something you DO for as long
// as you are there, and a one-shot write does not need a window at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { B3Result } from '@novakai/foundation/dist/contract/index.js';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import type { TerminalSession } from '../../terminal/contract/index.js';
import type { RuntimeStatus } from '../../agent-runtime/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';

const repoRoot = path.resolve('../..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const terminalCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-terminal.ts');

interface CliOutcome {
  readonly code: number | null;
  readonly json: { ok: boolean; value?: unknown; error?: { code: string } } | null;
  readonly stderr: string;
}

/**
 * Async on purpose: the runtime host is running in THIS process, so a
 * synchronous spawn would block the very event loop the CLI is trying to reach.
 */
function runCli(root: string, port: number, args: readonly string[]): Promise<CliOutcome> {
  const child = spawn(
    process.execPath,
    [tsx, terminalCli, ...args, '--json', '--root', root, '--port', String(port)],
    { cwd: repoRoot },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise<CliOutcome>((resolve) => {
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      let parsed: CliOutcome['json'] = null;
      try { parsed = line ? JSON.parse(line) as CliOutcome['json'] : null; } catch { parsed = null; }
      resolve({ code, json: parsed, stderr });
    });
  });
}

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

async function controllerCount(root: string, host: RunningRuntimeHost): Promise<number> {
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    return unwrap(await client.call<RuntimeStatus>('b3.runtime.getStatus', {}), 'status')
      .attachedControllerCount;
  } finally {
    client.close();
  }
}

async function settlesTo(
  root: string, host: RunningRuntimeHost, expected: number, within = 10_000,
): Promise<number> {
  const deadline = Date.now() + within;
  let seen = await controllerCount(root, host);
  while (seen !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    seen = await controllerCount(root, host);
  }
  return seen;
}

async function rigWithSession(label: string) {
  const root = mkdtempSync(path.join(tmpdir(), label));
  const host = await startRuntimeHost({ root, port: 0, ptyHost: createFakePtyHost() });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  const session = unwrap(await client.call<TerminalSession>('b3.terminal.open', {
    owner: { kind: 'plain-shell', shellInstanceId: 'cli-test' },
    launchAuthorityRef: 'plain-shell',
    launchFingerprint: 'plain-shell:/bin/zsh',
    workingDirectory: '/tmp', columns: 80, rows: 24,
  }), 'open');
  client.close();
  return { root, host, session };
}

test('a scripted write needs no window and leaves none behind', async () => {
  const { root, host, session } = await rigWithSession('nvk-cli-write-');
  try {
    const written = await runCli(root, host.port, [
      'write', '--session', session.id, '--text', 'echo hello\r',
    ]);
    assert.equal(written.json?.ok, true,
      `a one-shot write failed: ${written.stderr.trim()}`);
    assert.equal(await settlesTo(root, host, 0), 0,
      'a scripted write left a window attached behind it');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * NVK-KIMI-025 repair 1, the CLI half of the same defect. `--sequence` defaulted
 * to 1, so the SECOND scripted write into a session was refused with
 * `VersionConflict: the input stream moved on before this write` — the exact
 * failure Fable hit in the browser after reopening a window.
 *
 * A controller that has just arrived cannot know where the stream is, so it asks
 * rather than assuming it starts over.
 */
test('a second scripted write into the same session is not refused as a conflict', async () => {
  const { root, host, session } = await rigWithSession('nvk-cli-write-twice-');
  try {
    const first = await runCli(root, host.port, [
      'write', '--session', session.id, '--text', 'echo one\r',
    ]);
    assert.equal(first.json?.ok, true, `the first write failed: ${first.stderr.trim()}`);

    const second = await runCli(root, host.port, [
      'write', '--session', session.id, '--text', 'echo two\r',
    ]);
    assert.equal(second.json?.ok, true,
      `the second write was refused: ${JSON.stringify(second.json?.error)}`);
    assert.equal((second.json?.value as { inputSequence: number } | undefined)?.inputSequence, 2);

    // ...and an explicitly WRONG --sequence is still refused: the guard is not
    // being weakened, it is being told the truth.
    const stale = await runCli(root, host.port, [
      'write', '--session', session.id, '--text', 'echo stale\r', '--sequence', '1',
    ]);
    assert.equal(stale.json?.ok, false, 'a stale sequence was accepted');
    assert.equal(stale.json?.error?.code, 'VersionConflict');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('nvk-terminal attach holds the window open, then lets go when interrupted', async () => {
  const { root, host, session } = await rigWithSession('nvk-cli-attach-');
  const follower = spawn(
    process.execPath,
    [tsx, terminalCli, 'attach', session.id, '--root', root, '--port', String(host.port)],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  try {
    assert.equal(await settlesTo(root, host, 1), 1,
      'attaching did not hold the window open — it recorded and left');

    // Still there a moment later: attaching is something you DO, not a ping.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await controllerCount(root, host), 1);

    follower.kill('SIGINT');
    assert.equal(await settlesTo(root, host, 0), 0,
      'the window stayed attached after the process that opened it was gone');

    const alive = await runCli(root, host.port, ['inspect', session.id]);
    assert.equal(
      (alive.json?.value as { session: TerminalSession } | undefined)?.session.status,
      'live', 'detaching a controller ended the session (red gate 1)',
    );
  } finally {
    follower.kill('SIGKILL');
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
