// A stop that only half worked, and the door that finishes it (§20, §13.7).
//
// `stopAgentTree` reported `ok` over a PARTIAL stop — the operation stayed
// `tree-stop-pending`, which is right, but the command receipt settled
// `succeeded` over it, which meant the retry §20 promises ("resume same
// operation") replayed the pending value instead and the half-stopped subtree
// stayed half-stopped forever (NVK-KIMI-028 finding 6).
//
// `repairRunOperation` is the other half: §12.2 publishes it as THE recovery
// action for exactly this state, and it did nothing but re-read the record.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  b3err, mintClientOpId, mintTraceCorrelationId,
  type AgentId, type AgentRunId, type CommandContext, type RunOperationId,
} from '@novakai/foundation/contract';
import { createRunsRig, CHRIS, EVERY_SCOPE, type RunsRig } from '../runs-harness.js';

async function withRig<T>(work: (rig: RunsRig) => Promise<T>): Promise<T> {
  const rig = createRunsRig();
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

const spawnInput = (roleProfileId: string, displayName: string) => ({
  roleProfileId: roleProfileId as never,
  displayName,
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'do the thing' },
});

/** One retryable envelope, so a retry is the SAME command rather than a new one. */
function fixedContext(): CommandContext {
  return {
    principal: { id: CHRIS, kind: 'human', verifiedScopes: EVERY_SCOPE },
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

async function parentAndChild(rig: RunsRig): Promise<{
  parent: { agentId: AgentId; runId: AgentRunId };
  child: { agentId: AgentId; runId: AgentRunId };
}> {
  const childRole = rig.agents.defineRole('repair-child');
  const parentRole = rig.agents.defineRole('repair-parent', [childRole]);
  const parent = await rig.runtime.spawnAgent(rig.human(), spawnInput(parentRole, 'Parent'));
  assert.equal(parent.ok, true, parent.ok ? '' : parent.error.message);
  if (!parent.ok) throw new Error('unreachable');
  const child = await rig.runtime.spawnAgent(
    rig.agentRun(parent.value.run.id), spawnInput(childRole, 'Child'),
  );
  assert.equal(child.ok, true, child.ok ? '' : child.error.message);
  if (!child.ok) throw new Error('unreachable');
  return {
    parent: { agentId: parent.value.agent.agentId, runId: parent.value.run.id },
    child: { agentId: child.value.agent.agentId, runId: child.value.run.id },
  };
}

/** Prepare, then fail the FIRST terminate so the deepest Agent survives. */
async function partialStop(rig: RunsRig, context: CommandContext): Promise<{
  rootAgentId: AgentId;
  childAgentId: AgentId;
  outcome: Awaited<ReturnType<RunsRig['runtime']['stopAgentTree']>>;
}> {
  const family = await parentAndChild(rig);
  const prepared = await rig.runtime.prepareStopAgentTree(rig.human(), {
    rootAgentId: family.parent.agentId,
  });
  assert.equal(prepared.ok, true, prepared.ok ? '' : prepared.error.message);
  if (!prepared.ok) throw new Error('unreachable');

  rig.terminal.failTerminate = b3err('TerminalNotLive', 'the PTY did not answer',
    { terminalSessionId: 'unknown', status: 'unknown' }, true);
  const outcome = await rig.runtime.stopAgentTree(context, {
    rootAgentId: family.parent.agentId,
    confirmationToken: prepared.value.confirmationToken,
    confirmation: 'stop-tree',
  });
  return {
    rootAgentId: family.parent.agentId, childAgentId: family.child.agentId, outcome,
  };
}

test('a stop-tree that only half worked does not answer `ok`', async () => {
  await withRig(async (rig) => {
    const stop = await partialStop(rig, fixedContext());
    assert.equal(stop.outcome.ok, false,
      'a partial stop reported success, so its receipt cached success over it');
    if (stop.outcome.ok) return;
    assert.equal(stop.outcome.error.code, 'RecoveryRequired');
    assert.equal(typeof stop.outcome.error.details['operationId'], 'string',
      'the caller must be told WHICH operation to resume');
  });
});

test('retrying the same stop-tree command resumes it instead of replaying', async () => {
  await withRig(async (rig) => {
    const context = fixedContext();
    const stop = await partialStop(rig, context);
    assert.equal(stop.outcome.ok, false);

    // The identical command, with the identical clientOpId. §20: "resume same
    // operation". The injected terminate failure was one-shot, so a resume
    // finishes the job — and a replay would hand back the pending answer.
    const prepared = await rig.runtime.prepareStopAgentTree(rig.human(), {
      rootAgentId: stop.rootAgentId,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const again = await rig.runtime.stopAgentTree(context, {
      rootAgentId: stop.rootAgentId,
      confirmationToken: prepared.value.confirmationToken,
      confirmation: 'stop-tree',
    });
    assert.equal(again.ok, true, again.ok ? '' : `${again.error.code}: ${again.error.message}`);
    if (!again.ok) return;
    assert.equal(again.value.operation.state, 'completed');
    for (const outcome of again.value.perAgentOutcomes) {
      assert.equal(outcome.outcome, 'succeeded', `${outcome.agentId} was left behind`);
    }
  });
});

test('repairRunOperation resumes a pending tree stop through its own door', async () => {
  await withRig(async (rig) => {
    const stop = await partialStop(rig, fixedContext());
    assert.equal(stop.outcome.ok, false);
    if (stop.outcome.ok) return;
    const operationId = stop.outcome.error.details['operationId'] as RunOperationId;

    const repaired = await rig.runtime.repairRunOperation(rig.human(), operationId);
    assert.equal(repaired.ok, true,
      repaired.ok ? '' : `${repaired.error.code}: ${repaired.error.message}`);
    if (!repaired.ok) return;
    assert.equal(repaired.value.operation.state, 'completed',
      'repair left the operation pending');
    for (const outcome of repaired.value.perAgentOutcomes) {
      assert.equal(outcome.outcome, 'succeeded');
    }

    // And the subtree really is stopped, not just re-labelled.
    const live = await rig.runtime.listAgentRuns(rig.principal(), { includeFinal: false });
    assert.equal(live.ok, true);
    if (live.ok) assert.deepEqual(live.value.items.map((view) => view.agent.displayName), []);
  });
});

test('a half-stopped tree leaves its fence readable until repair releases it', async () => {
  await withRig(async (rig) => {
    const stop = await partialStop(rig, fixedContext());
    assert.equal(stop.outcome.ok, false);
    if (stop.outcome.ok) return;
    const operationId = stop.outcome.error.details['operationId'] as RunOperationId;

    // §13.7 step 7: the fence is released only on complete success. The blind
    // hold-out could not sample the window during a HEALTHY stop (330-440ms and
    // nothing observable), so it could neither confirm nor refute the fence.
    // A partial stop makes the same fact durable — and readable.
    const closing = await rig.runtime.getTreeFence(rig.principal(), {
      agentId: stop.childAgentId,
    });
    assert.equal(closing.ok, true, closing.ok ? '' : closing.error.message);
    if (!closing.ok) return;
    assert.notEqual(closing.value, null, 'a half-stopped tree reported no fence');
    assert.equal(closing.value?.state, 'closing');
    assert.equal(closing.value?.operationId, operationId,
      'the fence must name the operation to resume');

    const repaired = await rig.runtime.repairRunOperation(rig.human(), operationId);
    assert.equal(repaired.ok, true, repaired.ok ? '' : repaired.error.message);
    const released = await rig.runtime.getTreeFence(rig.principal(), {
      agentId: stop.childAgentId,
    });
    assert.equal(released.ok, true);
    if (released.ok) assert.equal(released.value, null, 'the fence outlived its operation');
  });
});

test('repairing an operation that is already finished changes nothing', async () => {
  await withRig(async (rig) => {
    const family = await parentAndChild(rig);
    const prepared = await rig.runtime.prepareStopAgentTree(rig.human(), {
      rootAgentId: family.parent.agentId,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const stopped = await rig.runtime.stopAgentTree(rig.human(), {
      rootAgentId: family.parent.agentId,
      confirmationToken: prepared.value.confirmationToken,
      confirmation: 'stop-tree',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
    if (!stopped.ok) return;

    const terminatedBefore = rig.terminal.terminated.length;
    const repaired = await rig.runtime.repairRunOperation(
      rig.human(), stopped.value.operation.id,
    );
    assert.equal(repaired.ok, true, repaired.ok ? '' : repaired.error.message);
    if (!repaired.ok) return;
    assert.equal(repaired.value.operation.state, 'completed');
    assert.equal(rig.terminal.terminated.length, terminatedBefore,
      'repair re-ran effects on a completed operation');
  });
});
