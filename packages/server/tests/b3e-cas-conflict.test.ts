// A2's exit condition, through the public CLI: **same ClientOpId resumes; a
// conflict is exit 4.**
//
// This test could not have been written before A5-02. When the CLI supplied its
// own precondition by reading the record first, a conflict was not reachable
// from the keyboard at all: whatever the operator believed, the CLI quoted the
// version it had just been handed, so the CAS matched by construction and the
// only way to see exit 4 was to race the CLI against itself. That is why this
// file lands with the precondition flags and not before them.
//
// Watchers are the subject rather than Agent Runs on purpose: a WatchRule is a
// durable CAS-guarded record that needs no provider, no PTY and no spawn, so
// this file states the law in seconds instead of minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/governed/contract/index.js';
import { startRuntimeHost } from '../core/runtime-host/host.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

const SUBJECT = 'agentRun_019fd000-0000-7000-8000-0000000000a1';
const CLIENT_OP = 'op_123e4567-e89b-42d3-a456-4266141740c1';

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

interface Envelope {
  readonly value?: { readonly id: string; readonly recordVersion: number };
  readonly error?: { readonly code?: string };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

async function withHost(
  body: (where: readonly string[]) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-cas-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  try {
    await body(['--root', root, '--port', String(host.port), '--json']);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const addWatch = (where: readonly string[], extra: readonly string[] = []): Promise<CliRun> =>
  runNvk(['watch', 'add', '--subject', SUBJECT, '--when', 'run-final',
    '--notify', 'human', '--delivery', 'queue-only', ...extra, ...where]);

test('a stale --expect-version is a CONFLICT the operator is told about — exit 4', async () => {
  await withHost(async (where) => {
    const created = envelopeOf(await addWatch(where));
    const ruleId = created.value!.id;
    const live = created.value!.recordVersion;

    // The operator looked at the rule, went to make coffee, somebody else moved
    // it on, and they came back and typed the version they remembered. Under
    // the old shape the CLI would have re-read the record and quietly retired
    // whatever the rule had become.
    const stale = await runNvk(['watch', 'remove', ruleId,
      '--expect-version', String(live + 1), ...where]);

    assert.equal(envelopeOf(stale).error?.code, 'WatcherConflict',
      `a mismatched precondition did not conflict: ${stale.out}`);
    assert.equal(stale.code, 4,
      `A5-11 puts a concurrency conflict at exit 4: ${stale.out}`);

    // And the rule is untouched — a refused CAS changes nothing.
    const listed = await runNvk(['watch', 'list', ...where]);
    const page = JSON.parse(listed.out) as {
      readonly value: { readonly rules: readonly { readonly status: string }[] };
    };
    assert.equal(page.value.rules[0]?.status, 'active',
      `the refused write landed anyway: ${listed.out}`);
  });
});

test('the matching --expect-version is accepted — the fence is not simply always closed', async () => {
  // Without this pair the test above would pass against a CLI that refused
  // every write, which is not what "the CAS works" means.
  await withHost(async (where) => {
    const created = envelopeOf(await addWatch(where));
    const removed = await runNvk(['watch', 'remove', created.value!.id,
      '--expect-version', String(created.value!.recordVersion), ...where]);
    assert.equal(removed.code, 0, removed.out);
  });
});

test('the same --client-op-id resumes one operation instead of doing it twice', async () => {
  await withHost(async (where) => {
    const first = await addWatch(where, ['--client-op-id', CLIENT_OP]);
    assert.equal(first.code, 0, first.out);
    const second = await addWatch(where, ['--client-op-id', CLIENT_OP]);
    assert.equal(second.code, 0, second.out);

    assert.equal(envelopeOf(second).value?.id, envelopeOf(first).value?.id,
      'the retry created a SECOND watcher: §17.2 says re-running the exact '
      + 'command resumes the exact operation');

    const listed = await runNvk(['watch', 'list', ...where]);
    const page = JSON.parse(listed.out) as {
      readonly value: { readonly rules: readonly unknown[] };
    };
    assert.equal(page.value.rules.length, 1,
      `two invocations left ${String(page.value.rules.length)} rules: ${listed.out}`);
  });
});

test('a DIFFERENT client-op-id is a different operation — idempotency is not deduplication', async () => {
  // The mirror image, and the one that says what resumption is NOT. Two
  // operators asking for the same watcher separately have asked twice.
  await withHost(async (where) => {
    assert.equal((await addWatch(where, ['--client-op-id', CLIENT_OP])).code, 0);
    const other = 'op_123e4567-e89b-42d3-a456-4266141740c2';
    assert.equal((await addWatch(where, ['--client-op-id', other])).code, 0);

    const listed = await runNvk(['watch', 'list', ...where]);
    const page = JSON.parse(listed.out) as {
      readonly value: { readonly rules: readonly unknown[] };
    };
    assert.equal(page.value.rules.length, 2, listed.out);
  });
});
