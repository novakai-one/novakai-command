// Stopping the runtime is an explicit, authorised choice (§13.10, red gate 1).
//
// Nothing here may be triggered by a window closing. A stop with live sessions
// either refuses and says what is still running, or stops them deliberately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId, mintRuntimeEpochId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type HumanPrincipalId, type TerminalSessionId,
} from '@novakai/foundation/contract';
import { composeRuntimeHost, createFileInstanceLease } from '../contract/index.js';
import { createFakeInstanceLease } from './fake-lease.js';
import { recordingCapability } from './fake-capability.js';

const principal: AuthenticatedPrincipal = {
  id: 'person_chris' as HumanPrincipalId, kind: 'human', verifiedScopes: [],
};

function humanContext(): CommandContext {
  return {
    principal, clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(), contractVersion: 1,
  };
}

function unwrap<T>(result: B3Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

const LIVE_SESSION = 'terminal_00000000-0000-7000-8000-000000000011' as TerminalSessionId;

test('a stop with --live-runs refuse changes nothing and names what is still running', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-stop-refuse-'));
  const capability = recordingCapability();
  capability.setCensus({
    liveTerminalSessionIds: [LIVE_SESSION], attachedControllerCount: 0, recoveryRequiredCount: 0,
    recoveryRequiredSessionIds: [],
  });
  const host = composeRuntimeHost({
    root, hostVersion: 'b3a-test', hostPid: 5001,
    lease: createFakeInstanceLease().forProcess(5001), capabilities: [capability],
  });
  try {
    const status = unwrap(await host.ensureLocalRuntime(humanContext()), 'ensure');
    const outcome = unwrap(await host.requestRuntimeStop(humanContext(), {
      expectedEpochId: status.activeEpochId, liveRuns: 'refuse',
    }), 'stop refuse');

    assert.equal(outcome.stopped, false);
    assert.deepEqual(outcome.refusedTerminalSessionIds, [LIVE_SESSION]);
    assert.deepEqual(capability.stoppedSessionIds, [], 'refuse stopped something anyway');
    // The runtime is still ours and still able to work.
    assert.equal(host.fence.assertActive(status.activeEpochId).ok, true);
  } finally {
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stop with --live-runs stop-explicitly stops them through their own authority', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-stop-explicit-'));
  const capability = recordingCapability();
  capability.setCensus({
    liveTerminalSessionIds: [LIVE_SESSION], attachedControllerCount: 1, recoveryRequiredCount: 0,
    recoveryRequiredSessionIds: [],
  });
  const host = composeRuntimeHost({
    root, hostVersion: 'b3a-test', hostPid: 5002,
    lease: createFakeInstanceLease().forProcess(5002), capabilities: [capability],
  });
  try {
    const status = unwrap(await host.ensureLocalRuntime(humanContext()), 'ensure');
    const outcome = unwrap(await host.requestRuntimeStop(humanContext(), {
      expectedEpochId: status.activeEpochId, liveRuns: 'stop-explicitly',
    }), 'stop explicitly');

    assert.equal(outcome.stopped, true);
    assert.deepEqual(outcome.stoppedTerminalSessionIds, [LIVE_SESSION]);
    assert.deepEqual(capability.stoppedSessionIds, [LIVE_SESSION]);
    // The epoch is gone, so nothing can mutate under it any more.
    assert.equal(host.fence.assertActive(status.activeEpochId).ok, false);
  } finally {
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stop naming the wrong epoch is refused outright', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-stop-stale-'));
  const capability = recordingCapability();
  const host = composeRuntimeHost({
    root, hostVersion: 'b3a-test', hostPid: 5003,
    lease: createFakeInstanceLease().forProcess(5003), capabilities: [capability],
  });
  try {
    const status = unwrap(await host.ensureLocalRuntime(humanContext()), 'ensure');
    const refused = await host.requestRuntimeStop(humanContext(), {
      expectedEpochId: mintRuntimeEpochId(), liveRuns: 'stop-explicitly',
    });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, 'StaleRuntimeEpoch');
    assert.equal(host.fence.assertActive(status.activeEpochId).ok, true);
  } finally {
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the REAL file lease is atomic, stealable only from a dead holder, and cleaned up', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-file-lease-'));
  const lockPath = path.join(root, 'runtime', 'runtime.lock');
  const living = new Set<number>([6001]);
  const isAlive = (processId: number): boolean => living.has(processId);
  try {
    const first = createFileInstanceLease({ root, hostPid: 6001, isAlive });
    const second = createFileInstanceLease({ root, hostPid: 6002, isAlive });

    assert.deepEqual(first.acquire(), { held: true });
    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(second.acquire(), { held: false, holderPid: 6001 });
    assert.equal(second.heldByThisProcess(), false);

    // Re-acquiring your own lease is a no-op, not a conflict.
    assert.deepEqual(first.acquire(), { held: true });

    living.delete(6001); // the owner died without releasing
    assert.deepEqual(second.acquire(), { held: true });
    assert.equal(second.heldByThisProcess(), true);
    assert.equal(first.heldByThisProcess(), false, 'a dead process still believed it held the lease');

    second.release();
    assert.equal(existsSync(lockPath), false, 'release left the lock behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime doctor explains a machine owned by another process instead of guessing', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-doctor-'));
  const leases = createFakeInstanceLease();
  const owner = composeRuntimeHost({
    root, hostVersion: 'b3a-test', hostPid: 7001, lease: leases.forProcess(7001),
  });
  const observer = composeRuntimeHost({
    root, hostVersion: 'b3a-test', hostPid: 7002, lease: leases.forProcess(7002),
  });
  try {
    const status = unwrap(await owner.ensureLocalRuntime(humanContext()), 'ensure');
    const report = unwrap(await observer.runtimeDoctor(principal), 'doctor');

    assert.equal(report.ownedByThisProcess, false);
    assert.equal(report.leaseHolderPid, 7001);
    assert.equal(report.leaseHolderAlive, true);
    assert.equal(report.activeEpoch?.id, status.activeEpochId);
    assert.ok(report.findings.some((line) => line.includes('7001')),
      'the doctor did not say who actually owns the runtime');
  } finally {
    await owner.shutdown();
    await observer.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
