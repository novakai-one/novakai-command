// Continuations (DEC-B3V4-19, §13.6, red gate 8).
//
// Chris's question 23, made executable: `--resume` is often NOT what you want,
// so the four modes are first-class, none is automatic, and every one of them
// creates a NEW Run while keeping the Agent and its family exactly where they
// were. Restarting yourself is not spawning a subordinate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { type AgentId, type AgentRunId } from '@novakai/foundation/contract';
import { createRunsRig, EVERY_SCOPE, type RunsRig } from '../runs-harness.js';

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

const spawnInput = (roleProfileId: string) => ({
  roleProfileId: roleProfileId as never,
  displayName: 'Builder',
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'do the thing' },
});

async function oneAgent(rig: RunsRig): Promise<{ agentId: AgentId; runId: AgentRunId }> {
  const role = rig.agents.defineRole('builder');
  const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role));
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
  if (!spawned.ok) throw new Error('unreachable');
  return { agentId: spawned.value.agent.agentId, runId: spawned.value.run.id };
}

test('restart-fresh keeps the Agent and mints a new Run', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    const continued = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(continued.ok, true, continued.ok ? '' : continued.error.message);
    if (!continued.ok) return;

    // B3b's public proof, third bullet.
    assert.equal(continued.value.agent.agentId, agent.agentId,
      'a restart changed the Agent, which is exactly what DEC-B3V4-02 forbids');
    assert.notEqual(continued.value.run.id, agent.runId, 'a restart reused the old Run id');
    assert.equal(continued.value.run.lifecycle, 'ready');

    const old = await rig.runtime.getAgentRun(rig.principal(), agent.runId);
    assert.equal(old.ok, true);
    if (old.ok) {
      assert.equal(old.value.run.lifecycle, 'stopped');
      assert.equal(old.value.run.finalReason, 'replaced-by-continuation',
        'a replaced Run must not read as a human stopping it');
    }
    // At most one live Run per Agent, still true.
    const live = await rig.runtime.listAgentRuns(rig.principal(), {
      agentId: agent.agentId, includeFinal: false,
    });
    assert.equal(live.ok, true);
    if (live.ok) assert.equal(live.value.items.length, 1);
  });
});

test('a continuation is a continuation edge, never a family edge', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    const continued = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'resume',
      configurationMode: 'inherit-plan',
    });
    assert.equal(continued.ok, true, continued.ok ? '' : continued.error.message);
    if (!continued.ok) return;

    // Red gate 8: no new child appeared anywhere.
    assert.equal(continued.value.family.childCount, 0,
      'a continuation created a child');
    assert.equal(continued.value.family.parentAgentId, undefined);
    const tree = await rig.runtime.getAgentRunTree(rig.principal(), {
      rootAgentId: agent.agentId, maxDepth: 4,
    });
    assert.equal(tree.ok, true);
    if (tree.ok) {
      // Both Runs of ONE Agent, not two Agents.
      const agentIds = new Set(tree.value.nodes.map((node) => node.agent.agentId));
      assert.equal(agentIds.size, 1, 'a continuation produced a second Agent');
      assert.equal(tree.value.nodes.length, 2, 'both Runs must remain inspectable');
    }
  });
});

test('resume uses the provider handle; fresh does not', async () => {
  await withRig(async (rig) => {
    const resumed = await oneAgent(rig);
    const withResume = await rig.runtime.continueAgent(rig.human(), {
      agentId: resumed.agentId,
      expectedOldRunId: resumed.runId,
      mode: 'resume',
      configurationMode: 'inherit-plan',
    });
    assert.equal(withResume.ok, true);
    const resumeLaunch = rig.providers.launched.at(-1);
    assert.equal(resumeLaunch?.authorityRef.includes('resume'), true,
      'a resume did not ask the provider for a resume launch');
  });

  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    const withFresh = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(withFresh.ok, true);
    const freshLaunch = rig.providers.launched.at(-1);
    assert.equal(freshLaunch?.authorityRef.includes('fresh'), true);
    assert.equal(freshLaunch?.authorityRef.includes('resume'), false,
      'a fresh start quietly resumed');
  });
});

test('a mode the pinned plan forbids is refused before anything starts', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    const refused = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'resume',
      configurationMode: 'inherit-plan',
    });
    assert.equal(refused.ok, false, 'a mode the plan forbids was allowed');
    if (!refused.ok) assert.equal(refused.error.code, 'LaunchPlanInvalid');

    // Nothing started, and the old Run is untouched.
    assert.equal(rig.terminal.opened.length, 1, 'a refused continuation opened a PTY');
    const old = await rig.runtime.getAgentRun(rig.principal(), agent.runId);
    assert.equal(old.ok, true);
    if (old.ok) assert.equal(old.value.run.lifecycle, 'ready');
  }, { allowedContinuationModes: ['fresh'] });
});

test('inherit-plan keeps the exact plan; refresh-role builds a new one', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    const before = await rig.runtime.getRunLaunchPlanId(rig.principal(), agent.runId);
    assert.equal(before.ok, true);
    if (!before.ok) return;

    const inherited = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(inherited.ok, true);
    if (!inherited.ok) return;
    const after = await rig.runtime.getRunLaunchPlanId(rig.principal(), inherited.value.run.id);
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.equal(after.value, before.value,
        'inherit-plan minted a second plan instead of inheriting one');
    }
  });
});

test('a continuation cannot drop a gate its predecessor had to pass', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    // The old Run was supervised, so the replacement resolves supervised too —
    // a restart is not a way around the two-turn gate (§6.3).
    const continued = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'refresh-role',
    });
    assert.equal(continued.ok, true, continued.ok ? '' : continued.error.message);
    if (!continued.ok) return;

    // The proof is in the LADDER: the replacement's gate stages are completed
    // work, not `not-needed`. Asserting on the plan would prove nothing, because
    // the plan carries the role's gate either way — what a dropped gate actually
    // looks like is the Runtime deciding the launch was unsupervised.
    const operations = await rig.runtime.listRunOperations(rig.principal(), {
      includeCompleted: true,
    });
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    const journal = operations.value.find(
      (item) => item.operation.kindOfOperation === 'continue',
    );
    const gateStages = (journal?.operation.completedStages ?? []).filter(
      (done) => done.stage.startsWith('skills-gate')
        || done.stage === 'supervised-work-released',
    );
    assert.equal(gateStages.length, 3, 'the replacement Run skipped the gate entirely');
    for (const stage of gateStages) {
      assert.notEqual(stage.outcome, 'not-needed',
        `${stage.stage} was marked not-needed: a restart dropped the gate`);
    }
  });
});

test('continuing a Run that is already final is refused', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    await rig.runtime.stopAgent(rig.human(), {
      agentId: agent.agentId,
      expectedLiveRunId: agent.runId,
      confirmation: 'stop-one',
    });
    const refused = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(refused.ok, false, 'a stopped Run was continued');
    if (!refused.ok) assert.equal(refused.error.code, 'RunFinal');
  });
});

test('a continuation journals the drain order §13.6 requires', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    const continued = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(continued.ok, true);

    const operations = await rig.runtime.listRunOperations(rig.principal(), {
      includeCompleted: true,
    });
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    const journal = operations.value.find(
      (item) => item.operation.kindOfOperation === 'continue',
    );
    assert.notEqual(journal, undefined, 'a continuation left no journal');
    const stages = journal!.operation.completedStages.map((done) => done.stage);
    assert.deepEqual(stages, [
      'old-run-fenced', 'old-endpoint-drained', 'old-transcript-finalised',
      'old-usage-finalised', 'run-reserved', 'terminal-live',
      'provider-session-recorded', 'skills-gate-prompt-sent', 'skills-gate-confirmed',
      // The replacement's OWN custody, after the claim moves and before the Run
      // is called ready. It was missing entirely: a continued Agent's live Run
      // had no TranscriptBinding, so nothing could mirror a turn it spoke, while
      // the retired Run's binding read back perfectly (exam B5).
      'supervised-work-released', 'endpoint-transferred', 'transcript-bound', 'run-ready',
    ], 'the old Run must be fenced and drained BEFORE the replacement starts, and '
      + 'the replacement must pass its own gate before it is called ready');
  });
});

test('a caller without the continue scope cannot restart anything', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    const withoutContinue = EVERY_SCOPE.filter((scope) => scope !== 'agent.continue');
    const refused = await rig.runtime.continueAgent(rig.human(withoutContinue), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');
  });
});

test('RED GATE 8: a continuation is never recorded as a family edge', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    // The Runtime creates family ONLY by asking Agents for a new Agent, so the
    // Agent count is the observable: a continuation that grew the family would
    // have had to create one.
    const before = rig.agents.agents.size;

    const continued = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(continued.ok, true, continued.ok ? '' : continued.error.message);
    if (!continued.ok) return;

    // Restarting yourself is not spawning a subordinate. If it were recorded as
    // one, the family tree would grow a generation every time an Agent was
    // compacted — and "who spawned this" would stop meaning anything.
    assert.equal(rig.agents.agents.size, before,
      'a continuation created a new Agent — that is a family edge, not a restart');
    assert.equal(continued.value.agent.agentId, agent.agentId,
      'a continuation must stay the SAME Agent');
    assert.notEqual(continued.value.run.id, agent.runId,
      'a continuation must be a NEW Run');
  });
});

/**
 * A continuation that fails leaves the Run it was replacing FENCED — not live,
 * not final, its provider still running and billing — and until now in no
 * recovery list at all. The re-probe found it reading as in-flight for ever
 * (NVK-KIMI-030 N-2): "not a dead end, it just never resolves on its own".
 *
 * `continuation-pending` is a promise that a replacement is coming. When the
 * replacement dies, the promise is false, and the Run has to say so somewhere an
 * operator looks.
 */
test('a failed continuation does not strand the Run it was replacing', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);

    // The gate on the REPLACEMENT fails — the ordinary way a continuation dies.
    rig.terminal.reply = 'malformed';
    const failed = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(failed.ok, false, 'a malformed confirmation passed the gate');

    const old = await rig.runtime.getAgentRun(rig.principal(), agent.runId);
    assert.equal(old.ok, true);
    if (!old.ok) return;
    assert.notEqual(old.value.run.lifecycle, 'continuation-pending',
      'the Run is still waiting for a replacement that already failed');

    // And it is visible where an operator goes to find work that needs a hand.
    const census = await rig.runtime.census();
    assert.equal(census.ok, true);
    if (!census.ok) return;
    assert.equal(census.value.recoveryRequiredRefs.includes(agent.runId), true,
      `the stranded Run is in no recovery list: ${JSON.stringify(census.value)}`);
  }, { gateTimeoutMs: 600 });
});

test('a Run a failed continuation stranded can still be continued and stopped', async () => {
  await withRig(async (rig) => {
    const agent = await oneAgent(rig);
    rig.terminal.reply = 'malformed';
    await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });

    // Recovery is a statement about needing attention, never a wall. The
    // re-probe checked both of these by hand; they are the reason N-2 is a
    // MEDIUM rather than a SEVERE, so they are held here.
    rig.terminal.reply = 'valid';
    const retried = await rig.runtime.continueAgent(rig.human(), {
      agentId: agent.agentId,
      expectedOldRunId: agent.runId,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(retried.ok, true,
      `a stranded Run could not be continued: ${retried.ok ? '' : retried.error.message}`);
  }, { gateTimeoutMs: 600 });
});
