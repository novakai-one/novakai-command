// Split-brain (DEC-B3V4-27, red gate 28) — a named B3a exit proof.
//
// Two things must be impossible: two processes both believing they own this
// machine's runtime, and a superseded process still able to mutate. Everything
// here is about proving the fence, not about believing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId, mintRuntimeEpochId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type HumanPrincipalId,
} from '@novakai/foundation/contract';
import {
  composeRuntimeHost, type RecoverableCapability, type RuntimeHostContract,
} from '../contract/index.js';
import { createFakeInstanceLease, type FakeLeaseWorld } from './fake-lease.js';
import { recordingCapability, type RecordingCapability } from './fake-capability.js';

const chris = 'person_chris' as HumanPrincipalId;
const principal: AuthenticatedPrincipal = { id: chris, kind: 'human', verifiedScopes: [] };

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

interface World {
  readonly root: string;
  readonly leases: FakeLeaseWorld;
  host(processId: number, capabilities?: RecoverableCapability[]): RuntimeHostContract;
  cleanup(): void;
}

function createWorld(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-runtime-'));
  const leases = createFakeInstanceLease();
  return {
    root, leases,
    host(processId, capabilities = []) {
      return composeRuntimeHost({
        root, hostVersion: 'b3a-test', hostPid: processId,
        lease: leases.forProcess(processId), capabilities,
      });
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('two simultaneous ensures converge on exactly ONE active epoch', async () => {
  const world = createWorld();
  const host = world.host(4001);
  try {
    const [left, right] = await Promise.all([
      host.ensureLocalRuntime(humanContext()),
      host.ensureLocalRuntime(humanContext()),
    ]);
    const first = unwrap(left, 'ensure 1');
    const second = unwrap(right, 'ensure 2');
    assert.equal(first.activeEpochId, second.activeEpochId, 'two ensures minted two epochs');
    assert.equal(first.ownedByThisProcess, true);
    assert.equal(first.state, 'active');
  } finally {
    await host.shutdown();
    world.cleanup();
  }
});

test('a second process cannot become the runtime while the first is alive', async () => {
  const world = createWorld();
  const owner = world.host(4001);
  const intruder = world.host(4002);
  try {
    const owned = unwrap(await owner.ensureLocalRuntime(humanContext()), 'owner ensure');

    // The intruder converges on the SAME runtime; it does not start a second.
    const seen = unwrap(await intruder.ensureLocalRuntime(humanContext()), 'intruder ensure');
    assert.equal(seen.activeEpochId, owned.activeEpochId, 'a second runtime was started');
    assert.equal(seen.ownedByThisProcess, false, 'a non-owner claimed ownership');

    // ...and it may NOT mutate: the fence refuses even the live epoch id.
    const fenced = intruder.fence.assertActive(owned.activeEpochId);
    assert.equal(fenced.ok, false, 'a non-owning process was allowed to mutate');
    if (fenced.ok) return;
    assert.equal(fenced.error.code, 'StaleRuntimeEpoch');

    // The real owner is unaffected.
    assert.equal(owner.fence.assertActive(owned.activeEpochId).ok, true);
  } finally {
    await owner.shutdown();
    await intruder.shutdown();
    world.cleanup();
  }
});

test('a dead holder is superseded, and its epoch becomes stale rather than lingering', async () => {
  const world = createWorld();
  const first = world.host(4001);
  const second = world.host(4002);
  try {
    const original = unwrap(await first.ensureLocalRuntime(humanContext()), 'first ensure');

    world.leases.kill(4001); // power loss, crash, force-quit — the lease is orphaned

    const taken = unwrap(await second.ensureLocalRuntime(humanContext()), 'second ensure');
    assert.notEqual(taken.activeEpochId, original.activeEpochId, 'the new host reused a dead epoch');
    assert.equal(taken.ownedByThisProcess, true);

    // The superseded epoch may no longer authorise anything, anywhere.
    assert.equal(second.fence.assertActive(original.activeEpochId).ok, false,
      'a superseded epoch still authorised mutations');
    const doctor = unwrap(await second.runtimeDoctor(principal), 'doctor');
    assert.equal(doctor.supersededEpochs, 1);
    assert.equal(doctor.activeEpoch?.id, taken.activeEpochId);
  } finally {
    await first.shutdown();
    await second.shutdown();
    world.cleanup();
  }
});

test('the fence rejects an unknown epoch id and reports what IS active', async () => {
  const world = createWorld();
  const host = world.host(4001);
  try {
    const status = unwrap(await host.ensureLocalRuntime(humanContext()), 'ensure');
    const invented = mintRuntimeEpochId();
    const fenced = host.fence.assertActive(invented);
    assert.equal(fenced.ok, false);
    if (fenced.ok) return;
    assert.equal(fenced.error.code, 'StaleRuntimeEpoch');
    assert.equal(fenced.error.details['received'], invented);
    assert.equal(fenced.error.details['active'], status.activeEpochId);
  } finally {
    await host.shutdown();
    world.cleanup();
  }
});

test('boot recovery runs once per new epoch, before the runtime reports active', async () => {
  const world = createWorld();
  const capability: RecordingCapability = recordingCapability();
  const first = world.host(4001, [capability]);
  const second = world.host(4002, [capability]);
  try {
    const original = unwrap(await first.ensureLocalRuntime(humanContext()), 'first ensure');
    assert.deepEqual(capability.reconciledEpochs, [original.activeEpochId]);

    // Ensuring again on the SAME live epoch must not re-run recovery.
    await first.ensureLocalRuntime(humanContext());
    assert.deepEqual(capability.reconciledEpochs, [original.activeEpochId]);

    world.leases.kill(4001);
    const taken = unwrap(await second.ensureLocalRuntime(humanContext()), 'second ensure');
    assert.deepEqual(capability.reconciledEpochs, [original.activeEpochId, taken.activeEpochId]);
  } finally {
    await first.shutdown();
    await second.shutdown();
    world.cleanup();
  }
});

test('shutting down releases the lease so the next process can take over cleanly', async () => {
  const world = createWorld();
  const first = world.host(4001);
  const second = world.host(4002);
  try {
    const original = unwrap(await first.ensureLocalRuntime(humanContext()), 'first ensure');
    await first.shutdown();

    const taken = unwrap(await second.ensureLocalRuntime(humanContext()), 'second ensure');
    assert.equal(taken.ownedByThisProcess, true);
    assert.notEqual(taken.activeEpochId, original.activeEpochId);
  } finally {
    await second.shutdown();
    world.cleanup();
  }
});
