// Finding 3 (NVK-KIMI-021 SEVERE): the durable receipt layer could never fire.
//
// §17.2 mandates `--client-op-id <ClientOpId>` on every command; neither CLI
// accepted it, and both the CLI client and the browser client minted a fresh
// one per call. The receipt id is deterministic from
// {principal, operation, clientOpId} (§4.5), so every production request made a
// brand-new receipt: a retry was always a second command, and
// commandReceipts.jsonl was write-only growth. DEC-B3V4-30 and §3.2's
// "receive a caller-minted ClientOpId".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';

const repoRoot = path.resolve('../..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const terminalCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-terminal.ts');

/** A caller-minted operation id, exactly as a script would carry across a retry. */
const RETRY_ID = 'op_2f0d6a4e-9c31-4a7b-8f52-6d0b1c9e7a30';

interface CliOutcome {
  readonly code: number | null;
  readonly json: { ok: boolean; value?: unknown; error?: { code: string } } | null;
}

function runCli(root: string, port: number, args: readonly string[]): Promise<CliOutcome> {
  const child = spawn(
    process.execPath,
    [tsx, terminalCli, ...args, '--json', '--root', root, '--port', String(port)],
    { cwd: repoRoot },
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.resume();
  return new Promise<CliOutcome>((resolve) => {
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      let parsed: CliOutcome['json'] = null;
      try { parsed = line ? JSON.parse(line) as CliOutcome['json'] : null; } catch { parsed = null; }
      resolve({ code, json: parsed });
    });
  });
}

async function rig(label: string): Promise<{ root: string; host: RunningRuntimeHost }> {
  const root = mkdtempSync(path.join(tmpdir(), label));
  const host = await startRuntimeHost({ root, port: 0, ptyHost: createFakePtyHost() });
  return { root, host };
}

const openArgs = ['open', '--cwd', '/tmp', '--authority', 'plain-shell'];

test('the same --client-op-id twice is ONE terminal, not two', async () => {
  const { root, host } = await rig('nvk-opid-same-');
  try {
    const first = await runCli(root, host.port, [...openArgs, '--client-op-id', RETRY_ID]);
    const retry = await runCli(root, host.port, [...openArgs, '--client-op-id', RETRY_ID]);

    assert.equal(first.json?.ok, true);
    assert.equal(retry.json?.ok, true);
    assert.equal(
      (retry.json?.value as { id: string }).id,
      (first.json?.value as { id: string }).id,
      'a retry with the caller\'s own operation id started a second terminal',
    );

    const listed = await runCli(root, host.port, ['list', '--state', 'live']);
    // A5-05: the listing answers a Page. The count is the same fact, read
    // where the owner now publishes it.
    assert.equal((listed.json?.value as { items: unknown[] }).items.length, 1,
      'the machine ended up with two shells for one command');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two DIFFERENT commands are still two terminals', async () => {
  const { root, host } = await rig('nvk-opid-diff-');
  try {
    await runCli(root, host.port, openArgs);
    await runCli(root, host.port, openArgs);
    const listed = await runCli(root, host.port, ['list', '--state', 'live']);
    assert.equal((listed.json?.value as { items: unknown[] }).items.length, 2,
      'idempotency swallowed a genuinely separate request');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same id used for a DIFFERENT request is a conflict, never a second run', async () => {
  const { root, host } = await rig('nvk-opid-conflict-');
  try {
    await runCli(root, host.port, [...openArgs, '--client-op-id', RETRY_ID]);
    const different = await runCli(root, host.port, [
      'open', '--cwd', root, '--authority', 'plain-shell', '--client-op-id', RETRY_ID,
    ]);
    assert.equal(different.json?.ok, false);
    assert.equal(different.json?.error?.code, 'IdempotencyConflict');
    assert.equal(different.code, 4, 'a conflict must exit 4 (§17.2)');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a --client-op-id that is not one is refused, not quietly replaced', async () => {
  const { root, host } = await rig('nvk-opid-bad-');
  try {
    const refused = await runCli(root, host.port, [...openArgs, '--client-op-id', 'whatever']);
    assert.equal(refused.json?.ok, false);
    assert.equal(refused.json?.error?.code, 'ValidationFailed');
    assert.equal(refused.code, 2, 'a usage error must exit 2 (§17.2)');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
