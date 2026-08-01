// The crash matrix (§24.3 cases 2, 3, 30, 31; §20).
//
// One question, asked at every point in the ladder: if the process dies HERE
// and a retry arrives with the same command, does anything happen twice?
//
// The crash is modelled as the thing a crash actually is from inside an
// operation — the store stops accepting writes while the files it already wrote
// stay on disk. The retry is a genuinely new composition over the same root,
// because that is what a restarted Runtime is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId, mintTraceCorrelationId,
  type AgentRoleProfileId, type CommandContext,
} from '@novakai/foundation/contract';
import { createRunsRig, CHRIS, EVERY_SCOPE } from '../runs-harness.js';
import type { RunOperation } from '../../contract/runs.js';

/** One command, reused verbatim across the crash and the retry (§4.5). */
function sameCommand(): CommandContext {
  return {
    principal: { id: CHRIS, kind: 'human', verifiedScopes: EVERY_SCOPE },
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

const spawnInput = (roleProfileId: AgentRoleProfileId) => ({
  roleProfileId,
  displayName: 'Builder',
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'do the thing' },
});

interface CrashRun {
  readonly operations: readonly RunOperation[];
  /** What the DYING attempt left behind, before any retry. */
  readonly ptysBeforeRetry: number;
  readonly gateTurnsBeforeRetry: number;
  readonly ptysOpened: number;
  readonly gateTurnsSent: number;
  readonly runsCreated: number;
  readonly reservations: readonly (string | undefined)[];
  readonly recovered: boolean;
}

/**
 * Crash a spawn after exactly `writes` durable writes, then restart the Runtime
 * over the same root and retry the SAME command. Returns what exists afterwards.
 */
async function crashAndRetry(writes: number): Promise<CrashRun> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-crash-'));
  try {
    const command = sameCommand();
    const dying = createRunsRig({ root, crashAfterWrites: writes, gateTimeoutMs: 400 });
    const role = dying.agents.defineRole('builder');
    const first = await dying.runtime.spawnAgent(command, spawnInput(role));
    // Whether it crashed or squeaked through, the retry must be safe either way.
    const ptysBefore = dying.terminal.opened.length;
    const gateBefore = dying.terminal.submitted.length;
    void first;

    // A healthy store over the same files, with the same live ports. See
    // `RunsRigOptions.agents` for why the ports are shared: this models a store
    // that stopped accepting writes, not a process that died — and the retry
    // can therefore see what the session already printed.
    const restarted = createRunsRig({
      root,
      gateTimeoutMs: 400,
      agents: dying.agents,
      terminal: dying.terminal,
      providers: dying.providers,
    });

    const second = await restarted.runtime.spawnAgent(command, spawnInput(role));
    const journals = await restarted.runtime.listRunOperations(restarted.principal(), {
      includeCompleted: true,
    });
    assert.equal(journals.ok, true);
    const runs = await restarted.runtime.listAgentRuns(restarted.principal(), {
      includeFinal: true,
    });
    assert.equal(runs.ok, true);

    return {
      operations: journals.ok ? journals.value.map((item) => item.operation) : [],
      ptysBeforeRetry: ptysBefore,
      gateTurnsBeforeRetry: gateBefore,
      // The ports are SHARED, so these counters are the totals across both
      // attempts — which is exactly the question: did anything happen twice?
      ptysOpened: restarted.terminal.opened.length,
      gateTurnsSent: restarted.terminal.submitted.length,
      runsCreated: runs.ok ? runs.value.items.length : -1,
      reservations: (journals.ok ? journals.value : []).map(
        (item) => item.operation.reservedProviderSessionId,
      ),
      recovered: second.ok,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a crash at ANY point in the ladder never produces two Runs', async () => {
  // 0 writes = dead before the journal exists; 14 = past every stage. The whole
  // ladder, one crash point at a time.
  let recoveries = 0;
  for (let writes = 0; writes <= 14; writes += 1) {
    const outcome = await crashAndRetry(writes);
    assert.equal(outcome.operations.length <= 1, true,
      `crashing after ${writes} writes left ${outcome.operations.length} journals`);
    assert.equal(outcome.runsCreated <= 1, true,
      `crashing after ${writes} writes produced ${outcome.runsCreated} Runs`);
    if (outcome.recovered) recoveries += 1;
  }
  // Without this the suite would pass by never recovering ANYTHING — which is
  // exactly how it passed before the receipt layer was fixed. "No duplicates"
  // is trivially true when nothing succeeds.
  assert.equal(recoveries, 15,
    `only ${recoveries} of 15 crash points recovered; the rest proved nothing`);
});

test('a crash before the first journal append leaves nothing behind', async () => {
  // §20's first row: "receipt only; no spawn side effect exists".
  const outcome = await crashAndRetry(0);
  assert.equal(outcome.ptysBeforeRetry, 0,
    'a PTY was opened before the operation was durable');
  assert.equal(outcome.gateTurnsBeforeRetry, 0,
    'a turn was sent before the operation was durable');
  // And the retry, finding nothing, is free to do the whole thing exactly once.
  assert.equal(outcome.recovered, true);
  assert.equal(outcome.runsCreated, 1);
});

test('a crash after the journal keeps the SAME provider-session reservation', async () => {
  // §20: "operation contains reservedProviderSessionId → resume same operation
  // and same reservation", and never "mint or accept a substitute".
  for (let writes = 1; writes <= 6; writes += 1) {
    const outcome = await crashAndRetry(writes);
    const reservations = outcome.reservations.filter((item) => item !== undefined);
    assert.equal(new Set(reservations).size <= 1, true,
      `crashing after ${writes} writes produced ${new Set(reservations).size} reservations`);
  }
});

test('a crash never sends the gate turns twice', async () => {
  // §24.3 case 22: "duplicate or stale gate confirmation cannot release a
  // second work turn". A retry must observe what it already sent.
  for (let writes = 8; writes <= 14; writes += 1) {
    const outcome = await crashAndRetry(writes);
    assert.equal(outcome.gateTurnsSent, 2,
      `crashing after ${writes} writes sent ${outcome.gateTurnsSent} gate turns; `
      + 'a supervised launch is exactly two, however many times it is retried');
  }
});

test('a crash never opens a second PTY for one Run', async () => {
  // §13.5: "adopt same PTY or report recovery". Exactly one, at every point.
  for (let writes = 5; writes <= 14; writes += 1) {
    const outcome = await crashAndRetry(writes);
    assert.equal(outcome.ptysOpened, 1,
      `crashing after ${writes} writes opened ${outcome.ptysOpened} PTYs`);
  }
});

test('a stale epoch cannot advance any stage of an operation', async () => {
  const rig = createRunsRig();
  try {
    const role = rig.agents.defineRole('builder');
    // §24.3 case 2. A process that lost the machine may report, never mutate.
    rig.fence.stale = true;
    for (const attempt of [
      () => rig.runtime.spawnAgent(rig.human(), spawnInput(role)),
      () => rig.runtime.stopAgentTree(rig.human(), {
        rootAgentId: 'agent_00000000-0000-4000-8000-000000000000' as never,
        confirmationToken: 'x',
        confirmation: 'stop-tree' as const,
      }),
    ]) {
      const refused = await attempt();
      assert.equal(refused.ok, false, 'a stale epoch mutated');
      if (!refused.ok) assert.equal(refused.error.code, 'StaleRuntimeEpoch');
    }
    assert.equal(rig.terminal.opened.length, 0);
  } finally {
    rig.close();
  }
});

test('boot recovery reports an orphaned Run honestly, and never revives it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-boot-'));
  try {
    const first = createRunsRig({ root, gateTimeoutMs: 400 });
    const role = first.agents.defineRole('builder');
    const spawned = await first.runtime.spawnAgent(first.human(), spawnInput(role));
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    // A DIFFERENT epoch: the process that owned that PTY is gone.
    const restarted = createRunsRig({ root, gateTimeoutMs: 400 });
    for (const [id, held] of first.agents.agents) restarted.agents.agents.set(id, held);
    for (const [id, held] of first.agents.plans) restarted.agents.plans.set(id, held);

    const reconciled = await restarted.runtime.reconcileAfterRestart();
    assert.equal(reconciled.ok, true);
    if (reconciled.ok) {
      assert.equal(reconciled.value.reconciledRunIds.includes(spawned.value.run.id), true,
        'a Run from a dead epoch was left claiming to be live');
    }

    const after = await restarted.runtime.getAgentRun(
      restarted.principal(), spawned.value.run.id,
    );
    assert.equal(after.ok, true);
    if (after.ok) {
      // DEC-B3V4-23: interrupted, with the uncertainty stated. Not `stopped`,
      // which would imply somebody chose it; not `ready`, which would be a lie.
      assert.equal(after.value.run.lifecycle, 'interrupted');
      assert.equal(after.value.run.finalReason, 'runtime-reconciled-missing');
      assert.equal(after.value.run.uncertainty[0]?.code, 'provider-liveness-unknown');
    }
    assert.equal(restarted.agents.expiredRuns.includes(spawned.value.run.id), true,
      'an orphaned Run kept the authority it was handing out');
    // Recovery is a statement, not an action: nothing was restarted or killed.
    assert.equal(restarted.terminal.opened.length, 0);
    assert.equal(restarted.terminal.terminated.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconciling twice is idempotent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-boot2-'));
  try {
    const first = createRunsRig({ root, gateTimeoutMs: 400 });
    const role = first.agents.defineRole('builder');
    await first.runtime.spawnAgent(first.human(), spawnInput(role));

    const restarted = createRunsRig({ root, gateTimeoutMs: 400 });
    for (const [id, held] of first.agents.agents) restarted.agents.agents.set(id, held);
    for (const [id, held] of first.agents.plans) restarted.agents.plans.set(id, held);
    const once = await restarted.runtime.reconcileAfterRestart();
    const twice = await restarted.runtime.reconcileAfterRestart();
    assert.equal(once.ok && twice.ok, true);
    if (once.ok && twice.ok) {
      assert.equal(twice.value.reconciledRunIds.length, 0,
        'the second reconcile re-processed a Run it had already settled');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
