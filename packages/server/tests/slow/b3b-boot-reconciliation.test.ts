// Boot tells the truth about what the last Runtime left behind
// (§13.1.6, §20, §24.5, §25-B3b).
//
// §13.1.6: "Startup reconciles all non-final RunOperation records before
// accepting new lifecycle commands for their Agents." Only Terminal was ever
// registered as a recoverable capability, so nothing reconciled Runs at all.
// The hold-out found the consequence three ways — a SIGKILL mid-spawn, a failed
// spawn, and a plain restart — each leaving the same shape:
//
//     run      : lifecycle "provisioning", uncertainty []
//     operation: state "running"
//     runtime  : recoveryRequiredCount 0        <- the honesty failure
//
// A Run reported as still provisioning, by a Runtime simultaneously claiming
// nothing needs recovery. §24.5 is explicit that unavailable is not zero; a
// dead Run reported as starting up is worse than either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime } from '../../core/runtime-host/client.js';
import { governedRole } from '../governed-role.js';

interface RunSummary { run: { id: string; lifecycle: string; uncertainty?: readonly unknown[] } }
/**
 * `b3.agent.listOperations` publishes §12.7's RunOperationView — the operation
 * nested under `operation`, not flattened. Read as a flat record, every
 * `item.state` in this file was `undefined`, so every filter below matched
 * nothing and every assertion passed without looking at anything.
 */
interface OperationSummary { operation: { id: string; state: string } }
interface RuntimeStatus { recoveryRequiredCount: number }

/**
 * One data root, two Runtime lifetimes. The second is the restart — the same
 * store, a new epoch, and nothing carried over in memory.
 */
async function withRestart(
  first: (client: Awaited<ReturnType<typeof connectRuntime>>) => Promise<void>,
  second: (client: Awaited<ReturnType<typeof connectRuntime>>) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-boot-'));
  try {
    for (const act of [first, second]) {
      const host = await startRuntimeHost({
        root, port: 0, ptyHost: createFakePtyHost(),
        providers: createFakeProviderAdapters(), gateTimeoutMs: 1_500,
      });
      const client = await connectRuntime({ root, port: host.port, token: host.token });
      try {
        await act(client);
      } finally {
        await client.close();
        await host.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a restart reconciles the Runs and operations the last Runtime abandoned', async () => {
  await withRestart(
    async (client) => {
      const role = await client.call<{ id: string }>(
        'b3.agent.createRole', governedRole('boot-governed'), mintClientOpId(),
      );
      assert.equal(role.ok, true);
      if (!role.ok) return;
      // A governed launch nobody answers: the ordinary way a spawn dies in the
      // field, and the shape the hold-out found stranded.
      await client.call('b3.agent.spawn', {
        roleProfileId: role.value.id,
        displayName: 'Abandoned',
        workingDirectory: tmpdir(),
        task: { kind: 'supervised', brief: 'never answered' },
      }, mintClientOpId());
    },
    async (client) => {
      const runs = await client.call<{ items: readonly RunSummary[] }>(
        'b3.agent.listRuns', { includeFinal: true, limit: 50 }, mintClientOpId(),
      );
      assert.equal(runs.ok, true);
      if (!runs.ok) return;
      const provisioning = runs.value.items.filter(
        (view) => view.run.lifecycle === 'provisioning',
      );
      assert.deepEqual(provisioning.map((view) => view.run.id), [],
        'a Run is still "provisioning" under a Runtime that never started it');

      const operations = await client.call<readonly OperationSummary[]>(
        'b3.agent.listOperations', {}, mintClientOpId(),
      );
      assert.equal(operations.ok, true);
      if (!operations.ok) return;
      const unsettled = operations.value.filter(
        (item) => item.operation.state === 'running'
          || item.operation.state === 'continuation-pending',
      );
      assert.deepEqual(unsettled.map((item) => item.operation.id), [],
        'an operation from a dead Runtime is still "running"');
    },
  );
});

test('a Runtime holding stranded work does not report nothing needs recovery', async () => {
  await withRestart(
    async (client) => {
      const role = await client.call<{ id: string }>(
        'b3.agent.createRole', governedRole('boot-count'), mintClientOpId(),
      );
      assert.equal(role.ok, true);
      if (!role.ok) return;
      await client.call('b3.agent.spawn', {
        roleProfileId: role.value.id,
        displayName: 'Counted',
        workingDirectory: tmpdir(),
        task: { kind: 'supervised', brief: 'never answered' },
      }, mintClientOpId());
    },
    async (client) => {
      const status = await client.call<RuntimeStatus>(
        'b3.runtime.getStatus', {}, mintClientOpId(),
      );
      assert.equal(status.ok, true);
      if (!status.ok) return;
      // Reconciliation is allowed to CLEAR the count by settling everything
      // honestly — what it may never do is report zero while the records still
      // say otherwise. The first test proves the records; this one proves the
      // number agrees with them.
      const operations = await client.call<readonly OperationSummary[]>(
        'b3.agent.listOperations', {}, mintClientOpId(),
      );
      assert.equal(operations.ok, true);
      if (!operations.ok) return;
      const needingRecovery = operations.value.filter(
        (item) => item.operation.state === 'recovery-required',
      ).length;
      assert.equal(status.value.recoveryRequiredCount >= needingRecovery, true,
        `${String(needingRecovery)} operation(s) need recovery but the Runtime `
        + `reports ${String(status.value.recoveryRequiredCount)}`);
    },
  );
});

// Anchored to THIS file, not to the cwd: the suite is run both from the repo
// root and from `packages/server`, and a relative repo root is right in one.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const crashFixture = path.join(here, '..', 'fixtures', 'b3b-crash-mid-spawn.mts');

/** SIGKILL a Runtime while its spawn saga is genuinely in flight. */
async function crashMidSpawn(root: string): Promise<void> {
  // Its own process GROUP, because `tsx` re-execs node: killing the wrapper
  // alone leaves the real Runtime alive, which is not a crash — it is a Runtime
  // with nobody watching, and it quietly finishes the work the test needs
  // abandoned.
  const child = spawn(process.execPath, [tsx, crashFixture, root], {
    cwd: repoRoot, detached: true,
  });
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the crash fixture never reached its spawn')), 30_000);
    let seen = '';
    child.stdout.on('data', (chunk) => {
      seen += String(chunk);
      if (seen.includes('MID-SPAWN')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error('the crash fixture exited before it could be killed'));
    });
  });
  const ended = new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });
  process.kill(-child.pid!, 'SIGKILL');
  await ended;
  child.stdout.destroy();
  child.stderr.destroy();
}

test('a SIGKILL mid-spawn leaves nothing a restart cannot settle', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-crash-'));
  try {
    await crashMidSpawn(root);

    // The hold-out found this bricking roughly one boot in four: a mkdir-style
    // lock directory left behind by a SIGKILLed host, with no live process
    // holding it, that the next boot could never reclaim.
    const host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(),
      providers: createFakeProviderAdapters(), gateTimeoutMs: 1_500,
    });
    const client = await connectRuntime({ root, port: host.port, token: host.token });
    try {
      const runs = await client.call<{ items: readonly RunSummary[] }>(
        'b3.agent.listRuns', { includeFinal: true, limit: 50 }, mintClientOpId(),
      );
      assert.equal(runs.ok, true, runs.ok ? '' : `listRuns: ${runs.error.message}`);
      if (!runs.ok) return;
      assert.deepEqual(
        runs.value.items.filter((view) => view.run.lifecycle === 'provisioning')
          .map((view) => view.run.id),
        [],
        'a Run killed mid-spawn is still reported as provisioning',
      );

      const operations = await client.call<readonly OperationSummary[]>(
        'b3.agent.listOperations', {}, mintClientOpId(),
      );
      assert.equal(operations.ok, true);
      if (!operations.ok) return;
      assert.deepEqual(
        operations.value.filter((item) => item.operation.state === 'running')
          .map((item) => item.operation.id),
        [],
        'an operation from a SIGKILLed Runtime is still running',
      );
    } finally {
      await client.close();
      await host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The other half of the same question, through the real host boot path: once
 * the restart has said what needs recovery, can the operator ACT on it?
 *
 * Boot used to append an unconditional `uncertain` compensation line to every
 * abandoned operation, and repair refuses to close an operation carrying
 * uncertainty — so `recovery-required` was a terminal diagnosis rather than a
 * work item, and the published repair method could never succeed on the one
 * shape it exists for (NVK-KIMI-031 finding 1).
 */
test('an operation a SIGKILL abandoned can actually be repaired', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-repair-'));
  try {
    await crashMidSpawn(root);
    const host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(),
      providers: createFakeProviderAdapters(), gateTimeoutMs: 1_500,
    });
    const client = await connectRuntime({ root, port: host.port, token: host.token });
    try {
      const operations = await client.call<readonly OperationSummary[]>(
        'b3.agent.listOperations', {}, mintClientOpId(),
      );
      assert.equal(operations.ok, true);
      if (!operations.ok) return;
      const stranded = operations.value.filter(
        (item) => item.operation.state === 'recovery-required',
      );
      assert.equal(stranded.length >= 1, true,
        'the SIGKILL left no operation needing recovery, so this proves nothing');

      for (const item of stranded) {
        const repaired = await client.call<OperationSummary>(
          'b3.agent.repairOperation', { operationId: item.operation.id }, mintClientOpId(),
        );
        assert.equal(repaired.ok, true,
          `repair refused the operation it exists for: ${
            repaired.ok ? '' : repaired.error.message}`);
        if (repaired.ok) {
          assert.equal(repaired.value.operation.state, 'completed',
            'repair returned success without closing the operation');
        }
      }
    } finally {
      await client.close();
      await host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lock directory left by a hard kill does not brick the next boot', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-lock-'));
  try {
    await crashMidSpawn(root);
    // Whether or not the lock survived this particular kill, the next boot has
    // to come up. The hold-out watched it fail with "mutation lock held by a
    // live process" while no such process existed, and the only way out was
    // deleting a directory by hand.
    assert.equal(existsSync(root), true);
    const host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(),
      providers: createFakeProviderAdapters(), gateTimeoutMs: 1_500,
    });
    await host.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a spawn that dies after its Run exists compensates instead of stranding it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-compensate-'));
  const ptyHost = createFakePtyHost();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, providers: createFakeProviderAdapters(), gateTimeoutMs: 1_500,
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = await client.call<{ id: string }>(
      'b3.agent.createRole', governedRole('compensate'), mintClientOpId(),
    );
    assert.equal(role.ok, true);
    if (!role.ok) return;

    // The launch fails AFTER the Run record exists — the window where
    // compensation is the only thing standing between a failed spawn and a Run
    // that claims to be starting up forever.
    ptyHost.failNextStart('the provider could not be launched');
    const spawned = await client.call('b3.agent.spawn', {
      roleProfileId: role.value.id,
      displayName: 'Never Launched',
      workingDirectory: tmpdir(),
      task: { kind: 'supervised', brief: 'never begins' },
    }, mintClientOpId());
    assert.equal(spawned.ok, false, 'a spawn whose PTY never started reported success');

    const runs = await client.call<{ items: readonly RunSummary[] }>(
      'b3.agent.listRuns', { includeFinal: true, limit: 50 }, mintClientOpId(),
    );
    assert.equal(runs.ok, true);
    if (!runs.ok) return;
    assert.deepEqual(
      runs.value.items.filter((view) => view.run.lifecycle === 'provisioning')
        .map((view) => view.run.id),
      [],
      'the failed spawn left its Run provisioning, with nothing that will ever finish it',
    );

    const operations = await client.call<readonly OperationSummary[]>(
      'b3.agent.listOperations', {}, mintClientOpId(),
    );
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    assert.deepEqual(
      operations.value.filter((item) => item.operation.state === 'running')
        .map((item) => item.operation.id), [],
      'the failed spawn left its operation running',
    );
  } finally {
    await client.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
