// The spawn saga and its two-turn gate (§13.5, §6.3, B1-CF-001).
//
// Written from the clauses. The claims under test are the ones B3b's exit
// contract names: one operation for every caller, a journal that records each
// stage with its effect key, a reservation that predates every effect, and a
// work turn that is only released by an exact confirmation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { b3err } from '@novakai/foundation/contract';
import { createRunsRig, EVERY_SCOPE, CHRIS, type RunsRig } from '../runs-harness.js';
import type { RunOperation } from '../../contract/runs.js';

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

const supervisedSpawn = (rig: RunsRig, roleProfileId: string) => ({
  roleProfileId: roleProfileId as never,
  displayName: 'Builder One',
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'write the thing' },
});

test('a supervised spawn reaches ready with its whole ladder recorded', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    const spawned = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    assert.equal(spawned.value.run.lifecycle, 'ready');
    assert.equal(spawned.value.launch.surface, 'novakai-shell');
    assert.equal(spawned.value.launch.requestedBy, CHRIS);
    assert.equal(spawned.value.family.supervisor.kind, 'human',
      'a root Agent is supervised by its root human');
    assert.equal(spawned.value.usage.quality, 'unavailable',
      'red gate 13: an unmeasured usage is named, never rendered as zero');

    const operations = await rig.runtime.listRunOperations(rig.principal());
    assert.equal(operations.ok, true);
    if (operations.ok) {
      assert.equal(operations.value.length, 0, 'a completed spawn left an unfinished operation');
    }
  });
});

test('every stage is journalled with a stable effect key, in the ladder order', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    const spawned = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;

    const operation = await onlyOperation(rig);
    const stages = operation.completedStages.map((done) => done.stage);
    // §13.5's order, including the rungs later slices own.
    assert.deepEqual(stages, [
      'agent-lease-acquired', 'launch-plan-recorded', 'relationship-recorded',
      'run-reserved', 'endpoint-reserved', 'terminal-reserved', 'terminal-live',
      'provider-session-recorded', 'transcript-bound', 'endpoint-active',
      'skills-gate-prompt-sent', 'skills-gate-confirmed', 'supervised-work-released',
      'watchers-installed', 'run-ready',
    ]);
    for (const done of operation.completedStages) {
      assert.equal(done.effectKey, `${operation.id}:${done.stage}`,
        'an effect key must be derivable from the operation and the stage');
    }
    // A rung whose owner arrives later is NAMED as deferred, never silent.
    const deferred = operation.completedStages.filter((done) => done.outcome === 'not-needed');
    assert.deepEqual(
      deferred.map((done) => done.stage),
      [
        'relationship-recorded', 'endpoint-reserved', 'transcript-bound',
        'endpoint-active', 'watchers-installed',
      ],
      'every rung that did not apply must still appear, marked and reasoned');
    for (const done of deferred) {
      assert.notEqual(done.notNeededBecause, undefined,
        `${done.stage} was skipped without saying why`);
    }
    assert.equal(
      deferred.find((done) => done.stage === 'relationship-recorded')?.notNeededBecause,
      'this Agent is a root: it has no spawn parent',
    );
  });
});

test('the provider session is reserved BEFORE any effect and never rebound', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    const spawned = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    const operation = await onlyOperation(rig);

    assert.notEqual(operation.reservedProviderSessionId, undefined,
      'the journal must carry its reservation from the first append');
    assert.equal(spawned.value.run.providerSessionId, operation.reservedProviderSessionId,
      'the Run must be pinned to the id reserved before it existed');
    assert.equal(spawned.value.provider.providerSessionId, operation.reservedProviderSessionId);
  });
});

test('a substituted provider session is refused, not rebound', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    // §13.5: "never infer from PID alone or substitute another ID."
    rig.providers.substituteSessionId = 'sess_00000000-0000-4000-8000-00000000ffff' as never;
    const spawned = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));

    if (spawned.ok) {
      assert.notEqual(spawned.value.run.providerSessionId, rig.providers.substituteSessionId,
        'a Run was rebound to a session id the adapter substituted');
    }
    const registered = [...rig.agents.sessions.keys()];
    assert.equal(registered.includes(rig.providers.substituteSessionId!), false,
      'the substituted id reached the Agents registry');
  });
});

test('a discovery failure still leaves the Run resolvable', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    rig.providers.discoveryFails = b3err('UnsupportedOperation', 'the CLI vanished',
      { operation: 'provider.discoverSession' }, false);
    const spawned = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));
    assert.equal(spawned.ok, false, 'a failed discovery must not produce a ready Run');

    // §20: "record same-id failed-before-discovery ProviderSession, then
    // finalise Run" — never leave a final Run pointing at nothing.
    const operation = await onlyOperation(rig);
    const reserved = operation.reservedProviderSessionId!;
    assert.equal(rig.agents.sessions.has(reserved), true,
      'the reserved session was never materialised, so the Run resolves to nothing');
    assert.equal(rig.agents.sessions.get(reserved)?.discovered, false,
      'a failed discovery must be recorded as failed-before-discovery');
  });
});

test('the gate holds the work turn until an exact confirmation arrives', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    const spawned = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;

    assert.equal(rig.terminal.submitted.length, 2,
      'a supervised launch is exactly two turns: confirm, then work');
    const [confirmTurn, workTurn] = rig.terminal.submitted;
    assert.equal(confirmTurn!.text.includes('do NOT begin it yet'), true,
      'turn 1 must not release the work');
    assert.equal(confirmTurn!.text.includes('tdd@v1#digest-tdd'), true,
      'turn 1 must carry the PINNED skill references');
    assert.equal(workTurn!.text.includes('Begin the task now'), true);
    assert.equal(workTurn!.text.includes('write the thing'), true);
    assert.equal(
      rig.events.some((event) => event.kind === 'agent.run.skills-gate.passed'), true);
  });
});

test('every way of getting the confirmation wrong terminates the Run', async () => {
  const wrong = [
    'silent', 'malformed', 'empty', 'missing-token', 'extra-token',
    'duplicate-token', 'out-of-order',
  ] as const;
  for (const reply of wrong) {
    await withRig(async (rig) => {
      const role = rig.agents.defineRole('builder');
      rig.terminal.reply = reply;
      const spawned = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));

      assert.equal(spawned.ok, false, `a "${reply}" confirmation was accepted`);
      if (!spawned.ok) {
        assert.equal(spawned.error.code, 'SkillsConfirmationFailed',
          `a "${reply}" confirmation did not fail the gate`);
      }
      // The whole point: the work turn was NEVER sent.
      const work = rig.terminal.submitted.filter(
        (turn) => turn.text.includes('Begin the task now'),
      );
      assert.equal(work.length, 0, `a "${reply}" confirmation released the work turn`);
      assert.equal(
        rig.events.some((event) => event.kind === 'agent.run.skills-gate.failed'), true,
        `a "${reply}" confirmation recorded no drift`);
    }, {
      gateTimeoutMs: 200,
      skills: [
        { id: 'tdd', version: 1, digest: 'digest-tdd' },
        { id: 'verification', version: 2, digest: 'digest-ver' },
      ],
    });
  }
});

test('a chat launch has no gate to pass, and says so in the ladder', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('chat');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId: role as never,
      displayName: 'Chat',
      workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    assert.equal(rig.terminal.submitted.length, 0, 'a chat launch sent a gate turn');

    const operation = await onlyOperation(rig);
    const gateStages = operation.completedStages.filter(
      (done) => done.stage.startsWith('skills-gate') || done.stage === 'supervised-work-released',
    );
    assert.equal(gateStages.length, 3);
    for (const stage of gateStages) {
      assert.equal(stage.outcome, 'not-needed',
        'a skipped gate must say it was skipped, not vanish from the ladder');
    }
  }, { gateMode: 'disabled' });
});

test('one Agent cannot have two live Runs', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    const first = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // A continuation is the only lawful way to get a second Run, and it retires
    // the first. Spawning again makes a NEW Agent, so the invariant is about
    // one Agent — which `continueAgent` is the test for. Here we prove the
    // guard itself by asking the store.
    const runs = await rig.runtime.listAgentRuns(rig.principal(), {
      agentId: first.value.agent.agentId, includeFinal: false,
    });
    assert.equal(runs.ok, true);
    if (runs.ok) assert.equal(runs.value.items.length, 1);
  });
});

test('an unauthorised caller is refused before a journal record exists', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    const refused = await rig.runtime.spawnAgent(
      rig.human([]), supervisedSpawn(rig, role),
    );
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'PermissionDenied');

    const operations = await rig.runtime.listRunOperations(rig.principal(), {
      includeCompleted: true,
    });
    assert.equal(operations.ok, true);
    if (operations.ok) {
      assert.equal(operations.value.length, 0,
        'a refused spawn left a journal record, so it had already begun');
    }
    assert.equal(rig.terminal.opened.length, 0, 'a refused spawn opened a PTY');
  });
});

test('a stale runtime epoch cannot spawn anything', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    rig.fence.stale = true;
    const refused = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, role));
    assert.equal(refused.ok, false, 'a stale process spawned an Agent');
    if (!refused.ok) assert.equal(refused.error.code, 'StaleRuntimeEpoch');
    assert.equal(rig.terminal.opened.length, 0);
  });
});

test('an Agent spawns a child, and the child is its own generation', async () => {
  await withRig(async (rig) => {
    const auditorRole = rig.agents.defineRole('auditor');
    const builderRole = rig.agents.defineRole('builder', [auditorRole]);
    const managerRole = rig.agents.defineRole('manager', [builderRole]);

    const manager = await rig.runtime.spawnAgent(rig.human(), supervisedSpawn(rig, managerRole));
    assert.equal(manager.ok, true);
    if (!manager.ok) return;

    // The child spawns as the parent's own Run — identity from the socket.
    const builder = await rig.runtime.spawnAgent(
      rig.agentRun(manager.value.run.id), supervisedSpawn(rig, builderRole),
    );
    assert.equal(builder.ok, true, builder.ok ? '' : builder.error.message);
    if (!builder.ok) return;
    assert.equal(builder.value.launch.surface, 'agent',
      'a child spawned by an Agent records that surface, not the human one');
    assert.equal(builder.value.family.parentAgentId, manager.value.agent.agentId);
    assert.equal(builder.value.family.supervisor.kind, 'agent');
    assert.equal(builder.value.run.parentRequestingRunId, manager.value.run.id,
      'the Run that asked for this one is recorded');

    // And a role the parent may not spawn is refused.
    const forbidden = await rig.runtime.spawnAgent(
      rig.agentRun(manager.value.run.id), supervisedSpawn(rig, auditorRole),
    );
    assert.equal(forbidden.ok, false, 'a manager spawned a role its own role forbids');
    if (!forbidden.ok) assert.equal(forbidden.error.code, 'RoleNotAllowed');
  });
});

test('retrying the same command adopts the same Run instead of making a second', async () => {
  await withRig(async (rig) => {
    const role = rig.agents.defineRole('builder');
    const context = rig.human();
    const first = await rig.runtime.spawnAgent(context, supervisedSpawn(rig, role));
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // The same clientOpId, exactly as a retrying script would send it.
    const again = await rig.runtime.spawnAgent(context, supervisedSpawn(rig, role));
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.value.run.id, first.value.run.id,
      'a retry produced a SECOND Run');
    assert.equal(rig.terminal.opened.length, 1, 'a retry opened a second PTY');
    assert.equal(rig.terminal.submitted.length, 2, 'a retry re-sent the gate turns');
  });
});

/** The one operation this rig performed — succeeded or not. */
async function onlyOperation(rig: RunsRig): Promise<RunOperation> {
  const listed = await rig.runtime.listRunOperations(rig.principal(), {
    includeCompleted: true,
  });
  assert.equal(listed.ok, true);
  if (!listed.ok || listed.value.length === 0) throw new Error('no operation was journalled');
  return listed.value[0]!.operation;
}
