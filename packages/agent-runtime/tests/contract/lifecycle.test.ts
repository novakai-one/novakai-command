// Interrupt, stop, stop-tree, adoption (§13.3, §13.7, DEC-B3V4-07/10/11).
//
// The three things constantly mistaken for each other, tested apart:
// interrupting a turn is not stopping a Run, stopping a Run is not stopping a
// team, and changing who supervises an Agent is not changing who spawned it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  b3err, type AgentId, type AgentRunId, type RecordVersion,
} from '@novakai/foundation/contract';
import { createRunsRig, EVERY_SCOPE, CHRIS, type RunsRig } from '../runs-harness.js';
import type { AgentRun } from '../../contract/runs.js';

async function withRig<T>(
  work: (rig: RunsRig) => Promise<T>, options: Parameters<typeof createRunsRig>[0] = {},
): Promise<T> {
  const rig = createRunsRig(options);
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

const spawnInput = (roleProfileId: string, displayName = 'Agent') => ({
  roleProfileId: roleProfileId as never,
  displayName,
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'do the thing' },
});

/** Manager → Builder → Auditor, all live. The shape B3b must prove. */
async function threeGenerations(rig: RunsRig): Promise<{
  manager: { agentId: AgentId; runId: AgentRunId };
  builder: { agentId: AgentId; runId: AgentRunId };
  auditor: { agentId: AgentId; runId: AgentRunId };
}> {
  const auditorRole = rig.agents.defineRole('auditor');
  const builderRole = rig.agents.defineRole('builder', [auditorRole]);
  const managerRole = rig.agents.defineRole('manager', [builderRole]);

  const manager = await rig.runtime.spawnAgent(rig.human(), spawnInput(managerRole, 'Manager'));
  assert.equal(manager.ok, true, manager.ok ? '' : manager.error.message);
  if (!manager.ok) throw new Error('unreachable');
  const builder = await rig.runtime.spawnAgent(
    rig.agentRun(manager.value.run.id), spawnInput(builderRole, 'Builder'),
  );
  assert.equal(builder.ok, true, builder.ok ? '' : builder.error.message);
  if (!builder.ok) throw new Error('unreachable');
  const auditor = await rig.runtime.spawnAgent(
    rig.agentRun(builder.value.run.id), spawnInput(auditorRole, 'Auditor'),
  );
  assert.equal(auditor.ok, true, auditor.ok ? '' : auditor.error.message);
  if (!auditor.ok) throw new Error('unreachable');

  return {
    manager: { agentId: manager.value.agent.agentId, runId: manager.value.run.id },
    builder: { agentId: builder.value.agent.agentId, runId: builder.value.run.id },
    auditor: { agentId: auditor.value.agent.agentId, runId: auditor.value.run.id },
  };
}

test('interrupting a turn leaves the Run live and its children untouched', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const working = await markWorking(rig, family.manager.runId);

    const interrupted = await rig.runtime.interruptAgentTurn(rig.human(), {
      agentRunId: family.manager.runId,
      expectedRecordVersion: working.recordVersion,
    });
    assert.equal(interrupted.ok, true, interrupted.ok ? '' : interrupted.error.message);
    if (interrupted.ok) assert.equal(interrupted.value.kind, 'interrupted');

    // DEC-B3V4-10: interrupt is not stop. The Run stays live.
    const after = await rig.runtime.getAgentRun(rig.principal(), family.manager.runId);
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.notEqual(after.value.run.lifecycle, 'stopped');
      assert.equal(after.value.run.activity, 'interrupting');
    }
    // And the children carried on.
    for (const child of [family.builder, family.auditor]) {
      const view = await rig.runtime.getAgentRun(rig.principal(), child.runId);
      assert.equal(view.ok, true);
      if (view.ok) assert.equal(view.value.run.lifecycle, 'ready', 'a child died with a parent\'s turn');
    }
    assert.equal(rig.terminal.terminated.length, 0, 'an interrupt killed a PTY');
  });
});

test('interrupting a Run that is not working changes nothing at all', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('interactive');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId: role, displayName: 'Idle', workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const view = await rig.runtime.getAgentRun(rig.principal(), spawned.value.run.id);
    assert.equal(view.ok, true);
    if (!view.ok) return;

    const outcome = await rig.runtime.interruptAgentTurn(rig.human(), {
      agentRunId: spawned.value.run.id,
      expectedRecordVersion: view.value.run.recordVersion,
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      // §13.3 step 5: the lease, the draft and the queued input are untouched.
      assert.equal(outcome.value.kind, 'not-working');
      assert.equal(outcome.value.kind === 'not-working' && outcome.value.inputLeaseChanged, false);
    }
  });
});

test('a turn that finished before the barrier is not claimed as interrupted', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const working = await markWorking(rig, family.manager.runId);
    // Terminal says the tuple is no longer active — §13.3 step 4.
    rig.terminal.interruptOutcome = 'target-turn-not-active';

    const outcome = await rig.runtime.interruptAgentTurn(rig.human(), {
      agentRunId: family.manager.runId,
      expectedRecordVersion: working.recordVersion,
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.value.kind, 'not-working',
        'a finished turn was reported as interrupted');
      assert.equal(outcome.value.kind === 'not-working' && outcome.value.inputLeaseChanged, false);
    }
  });
});

test('a turn that finished AFTER the barrier reports the race, keeping the revocation', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const working = await markWorking(rig, family.manager.runId);
    rig.terminal.interruptOutcome = 'raced-with-completion';

    const outcome = await rig.runtime.interruptAgentTurn(rig.human(), {
      agentRunId: family.manager.runId,
      expectedRecordVersion: working.recordVersion,
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      // §20: the barrier WON the ordering race, so pretending the lease stayed
      // valid would be the lie. The revocation stands.
      assert.equal(outcome.value.kind, 'raced-with-completion');
      assert.equal(
        outcome.value.kind === 'raced-with-completion' && outcome.value.inputLeaseRevoked, true);
    }
  });
});

test('an interrupt at a stale record version loses rather than firing', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const working = await markWorking(rig, family.manager.runId);
    const stale = await rig.runtime.interruptAgentTurn(rig.human(), {
      agentRunId: family.manager.runId,
      expectedRecordVersion: (working.recordVersion - 1) as RecordVersion,
    });
    assert.equal(stale.ok, false, 'an interrupt fired against a version the caller never read');
    if (!stale.ok) assert.equal(stale.error.code, 'VersionConflict');
  });
});

test('stopping one Run stops its PTY and leaves its children supervised', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const stopped = await rig.runtime.stopAgent(rig.human(), {
      agentId: family.builder.agentId,
      expectedLiveRunId: family.builder.runId,
      confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
    if (stopped.ok) {
      assert.equal(stopped.value.run.lifecycle, 'stopped');
      assert.equal(stopped.value.run.finalReason, 'explicit-stop');
    }
    assert.equal(rig.terminal.terminated.length, 1, 'a stop did not stop its PTY');
    assert.equal(rig.agents.expiredRuns.includes(family.builder.runId), true,
      'a stopped Run kept the grants its authority came from');

    // DEC-B3V4-11: the grandchild keeps running and gains a new supervisor.
    const auditor = await rig.runtime.getAgentRun(rig.principal(), family.auditor.runId);
    assert.equal(auditor.ok, true);
    if (auditor.ok) {
      assert.equal(auditor.value.run.lifecycle, 'ready', 'a grandchild died with its parent');
      assert.notEqual(auditor.value.family.supervisor.kind, 'orphaned',
        'an orphan was left with nobody');
    }
    // Parentage is NEVER rewritten (red gate 9).
    if (auditor.ok) {
      assert.equal(auditor.value.family.parentAgentId, family.builder.agentId);
    }
  });
});

test('a stop whose PTY refuses is recovery-required, not a cheerful stop', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    rig.terminal.failTerminate = b3err('TerminalNotLive', 'the host is gone',
      { terminalSessionId: 'terminal_x', status: 'unknown' }, false);

    const stopped = await rig.runtime.stopAgent(rig.human(), {
      agentId: family.auditor.agentId,
      expectedLiveRunId: family.auditor.runId,
      confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true);
    if (stopped.ok) {
      assert.equal(stopped.value.run.lifecycle, 'recovery-required',
        'a PTY whose fate is unknown was reported as cleanly stopped');
      assert.equal(stopped.value.run.uncertainty[0]?.code, 'cleanup-incomplete');
    }
  });
});

test('a caller without the stop scope cannot stop anything', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const noScopes = EVERY_SCOPE.filter((scope) => scope !== 'agent.stop-one');
    const refused = await rig.runtime.stopAgent(rig.human(noScopes), {
      agentId: family.auditor.agentId,
      expectedLiveRunId: family.auditor.runId,
      confirmation: 'stop-one',
    });
    assert.equal(refused.ok, false, 'an unscoped caller stopped a Run');
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');
  });
});

test('stop-tree needs a token over the tree the caller was SHOWN', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const prepared = await rig.runtime.prepareStopAgentTree(rig.human(), {
      rootAgentId: family.manager.agentId,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.value.visibleDescendantCount, 2,
      'the confirmation must state how many Agents it covers');

    const forged = await rig.runtime.stopAgentTree(rig.human(), {
      rootAgentId: family.manager.agentId,
      confirmationToken: 'a-token-nobody-issued',
      confirmation: 'stop-tree',
    });
    assert.equal(forged.ok, false, 'a stop-tree ran on an unissued token');
    if (!forged.ok) assert.equal(forged.error.code, 'TreeClosing');

    const stopped = await rig.runtime.stopAgentTree(rig.human(), {
      rootAgentId: family.manager.agentId,
      confirmationToken: prepared.value.confirmationToken,
      confirmation: 'stop-tree',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
    if (!stopped.ok) return;
    assert.equal(stopped.value.operation.state, 'completed');
    // Every Agent's own result, so a partial failure is inspectable.
    assert.equal(stopped.value.perAgentOutcomes.length, 3);
    for (const outcome of stopped.value.perAgentOutcomes) {
      assert.equal(outcome.outcome, 'succeeded');
    }
    // Bottom-up: the grandchild's PTY went first.
    assert.equal(rig.terminal.terminated.length, 3);

    for (const member of [family.auditor, family.builder, family.manager]) {
      const view = await rig.runtime.getAgentRun(rig.principal(), member.runId);
      assert.equal(view.ok, true);
      if (view.ok) assert.equal(view.value.run.finalReason, 'explicit-tree-stop');
    }
  });
});

test('holding stop-one does not let a caller stop a tree', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const withoutTree = EVERY_SCOPE.filter((scope) => scope !== 'agent.stop-tree');
    const refused = await rig.runtime.prepareStopAgentTree(rig.human(withoutTree), {
      rootAgentId: family.manager.agentId,
    });
    assert.equal(refused.ok, false, '§22: stop-tree is a SEPARATE scope');
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');
  });
});

test('adoption moves supervision and never touches parentage', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const before = await rig.runtime.getAgentRun(rig.principal(), family.auditor.runId);
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.equal(before.value.family.supervisor.kind, 'agent');

    const adopted = await rig.runtime.adoptAgent(rig.human(), {
      subjectAgentId: family.auditor.agentId,
      expectedAssignmentVersion: 1 as RecordVersion,
      supervisor: { kind: 'agent', agentId: family.manager.agentId },
    });
    assert.equal(adopted.ok, true, adopted.ok ? '' : adopted.error.message);
    if (adopted.ok) {
      assert.equal(adopted.value.reason, 'explicit-adoption');
      assert.deepEqual(adopted.value.supervisor,
        { kind: 'agent', agentId: family.manager.agentId });
    }

    const after = await rig.runtime.getAgentRun(rig.principal(), family.auditor.runId);
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.deepEqual(after.value.family.supervisor,
        { kind: 'agent', agentId: family.manager.agentId });
      // Red gate 9: who SPAWNED it is untouched.
      assert.equal(after.value.family.parentAgentId, family.builder.agentId,
        'adoption rewrote immutable parentage');
    }
  });
});

test('two adoptions of the same Agent cannot both win', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const first = await rig.runtime.adoptAgent(rig.human(), {
      subjectAgentId: family.auditor.agentId,
      expectedAssignmentVersion: 1 as RecordVersion,
      supervisor: { kind: 'human', principalId: CHRIS },
    });
    assert.equal(first.ok, true);

    // The second caller read the SAME version the first one did.
    const second = await rig.runtime.adoptAgent(rig.human(), {
      subjectAgentId: family.auditor.agentId,
      expectedAssignmentVersion: 1 as RecordVersion,
      supervisor: { kind: 'agent', agentId: family.manager.agentId },
    });
    assert.equal(second.ok, false, 'two concurrent adoptions both won');
    if (!second.ok) assert.equal(second.error.code, 'VersionConflict');
  });
});

test('an ineligible supervisor is refused by name', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    const itself = await rig.runtime.adoptAgent(rig.human(), {
      subjectAgentId: family.auditor.agentId,
      expectedAssignmentVersion: 1 as RecordVersion,
      supervisor: { kind: 'agent', agentId: family.auditor.agentId },
    });
    assert.equal(itself.ok, false, 'an Agent adopted itself');
    if (!itself.ok) assert.equal(itself.error.code, 'SupervisorIneligible');

    // A descendant supervising its own ancestor is a supervision cycle even
    // though the FAMILY tree is untouched.
    const upward = await rig.runtime.adoptAgent(rig.human(), {
      subjectAgentId: family.manager.agentId,
      expectedAssignmentVersion: 1 as RecordVersion,
      supervisor: { kind: 'agent', agentId: family.auditor.agentId },
    });
    assert.equal(upward.ok, false, 'a descendant became its ancestor\'s supervisor');
    if (!upward.ok) assert.equal(upward.error.code, 'SupervisorIneligible');
  });
});

test('a supervisor with no live Run is refused', async () => {
  await withRig(async (rig) => {
    const family = await threeGenerations(rig);
    await rig.runtime.stopAgent(rig.human(), {
      agentId: family.manager.agentId,
      expectedLiveRunId: family.manager.runId,
      confirmation: 'stop-one',
    });
    const refused = await rig.runtime.adoptAgent(rig.human(), {
      subjectAgentId: family.auditor.agentId,
      expectedAssignmentVersion: 1 as RecordVersion,
      supervisor: { kind: 'agent', agentId: family.manager.agentId },
    });
    assert.equal(refused.ok, false, 'a dead Agent was made a supervisor');
    if (!refused.ok) assert.equal(refused.error.code, 'SupervisorIneligible');
  });
});

/**
 * Put a Run into a working turn by driving it the way the Runtime does. The
 * fake terminal accepts the turn; the Run records the tuple an interrupt needs.
 */
async function markWorking(rig: RunsRig, agentRunId: AgentRunId): Promise<AgentRun> {
  const view = await rig.runtime.getAgentRun(rig.principal(), agentRunId);
  assert.equal(view.ok, true);
  if (!view.ok) throw new Error('unreachable');
  const started = await rig.runtime.beginProviderTurn(rig.human(), {
    agentRunId,
    expectedRecordVersion: view.value.run.recordVersion,
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.message);
  const after = await rig.runtime.getAgentRun(rig.principal(), agentRunId);
  assert.equal(after.ok, true);
  if (!after.ok) throw new Error('unreachable');
  return after.value.run;
}

test('adoption cannot close a supervision cycle', async () => {
  await withRig(async (rig) => {
    // Two ROOT Agents, unrelated by family. Supervision is not parentage, so
    // either may lawfully be put under the other — and that is exactly why the
    // cycle check has to be about supervision rather than about descent.
    const role = rig.agents.defineRole('root');
    const first = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'First'));
    const second = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, 'Second'));
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;

    const under = await rig.runtime.adoptAgent(rig.human(), {
      subjectAgentId: first.value.agent.agentId,
      expectedAssignmentVersion: 1 as RecordVersion,
      supervisor: { kind: 'agent', agentId: second.value.agent.agentId },
    });
    assert.equal(under.ok, true, under.ok ? '' : under.error.message);

    // Now the other way, which closes the loop: each supervises the other, and
    // a supervisor chain that never reaches a human means nobody is accountable
    // for either of them. §13.7 requires the CAS to check that the candidate
    // "cannot create a cycle"; the check did not exist, and both
    // `RelationshipCycle` and `SupervisorIneligible` sat unused in the §11
    // table (hold-out F9).
    const cycle = await rig.runtime.adoptAgent(rig.human(), {
      subjectAgentId: second.value.agent.agentId,
      expectedAssignmentVersion: 1 as RecordVersion,
      supervisor: { kind: 'agent', agentId: first.value.agent.agentId },
    });
    assert.equal(cycle.ok, false, 'adoption closed a two-node supervision cycle');
    if (!cycle.ok) {
      assert.equal(
        cycle.error.code === 'RelationshipCycle' || cycle.error.code === 'SupervisorIneligible',
        true, `a cycle was refused as ${cycle.error.code}`);
    }
  });
});

test('a tree that is closing cannot gain a new child mid-stop', async () => {
  await withRig(async (rig) => {
    const childRole = rig.agents.defineRole('fence-child');
    const parentRole = rig.agents.defineRole('fence-parent', [childRole]);
    const parent = await rig.runtime.spawnAgent(rig.human(), spawnInput(parentRole, 'Parent'));
    assert.equal(parent.ok, true, parent.ok ? '' : parent.error.message);
    if (!parent.ok) return;

    const prepared = await rig.runtime.prepareStopAgentTree(rig.human(), {
      rootAgentId: parent.value.agent.agentId,
    });
    assert.equal(prepared.ok, true, prepared.ok ? '' : prepared.error.message);
    if (!prepared.ok) return;

    // The fence is only up WHILE the stop runs, so the spawn is fired from
    // inside the stop. Continue and adopt both check that fence; spawn never
    // did, so a parent inside a tree being stopped could add a child the stop
    // had already counted past — and the stop would then report success over a
    // live descendant it never saw (NVK-KIMI-028 finding 6, §13.7).
    let late: Awaited<ReturnType<typeof rig.runtime.spawnAgent>> | null = null;
    rig.terminal.duringNextTerminate = async () => {
      late = await rig.runtime.spawnAgent(
        rig.agentRun(parent.value.run.id), spawnInput(childRole, 'Late Child'),
      );
    };
    const stopped = await rig.runtime.stopAgentTree(rig.human(), {
      rootAgentId: parent.value.agent.agentId,
      confirmationToken: prepared.value.confirmationToken,
      confirmation: 'stop-tree',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);

    assert.notEqual(late, null, 'the spawn never ran inside the stop');
    const attempted = late as unknown as { ok: boolean; error?: { code: string } };
    assert.equal(attempted.ok, false, 'a closing tree gained a child after it was counted');
    if (!attempted.ok) assert.equal(attempted.error?.code, 'TreeClosing');
  });
});
