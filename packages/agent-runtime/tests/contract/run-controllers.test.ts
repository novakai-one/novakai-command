// B3e lane A — A7-03 items 4/5 (NVK-KIMI-094 Q3, and T-06 as ruled by
// NVK-KIMI-089 ruling 2): `AgentRunView.controllers`, and the
// `ListAgentRunsFilter.controllerState` filter that is unverifiable without it.
//
// §19.1's MUST-show list requires the view to answer "which controllers are
// connected now". §17.2:3574 requires the human line to say "currently 0
// controllers" beside launch origin. §24.5 red-gates the 0/1/many axis against
// "'No controller' is not 'Agent stopped'". None of it was reachable: the
// product's `AgentRunView` had no `controllers` member at all, while its own
// header comment claimed "Launch origin and current attachments are SEPARATE
// fields" — describing a field that was not there.
//
// So the defect has two halves and they are one defect: the filter
// (`controllerState`, §12.7:2647, carrying Chris point 6's "live/HEADLESS/
// final list") was dropped, AND the projection that lets a caller check the
// filter's own answer was dropped with it. Restoring one without the other
// leaves a filter nobody can verify.
//
// This suite owns the OWNER's half of the contract — what the view carries,
// what happens when Terminal cannot answer, and that the filter selects
// conjunctively. Rules 1–3 (which attachments count as connected, how `kinds`
// is deduplicated and ordered, which lease is the holder) are derived in the
// server's Terminal port from one published Terminal read, and are proven
// there against a real Terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { b3err } from '@novakai/foundation/contract';
import { createRunsRig, EVERY_SCOPE, type RunsRig } from '../runs-harness.js';
import type { ControllerAttachmentId } from '@novakai/foundation/contract';

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
  displayName: 'Controller subject',
  workingDirectory: rig.root,
  supervision: { kind: 'human' as const, principalId: 'person_chris' as never },
});

/** One live Run, spawned the way every other contract suite spawns one. */
async function spawnOne(rig: RunsRig): Promise<{ agentId: string; runId: string }> {
  const role = rig.agents.defineRole('controller-builder');
  const spawned = await rig.runtime.spawnAgent(rig.human(EVERY_SCOPE), supervisedSpawn(rig, role));
  assert.equal(spawned.ok, true, `spawn failed: ${JSON.stringify(spawned)}`);
  if (!spawned.ok) throw new Error('unreachable');
  return { agentId: String(spawned.value.agent.agentId), runId: String(spawned.value.run.id) };
}

test('the view carries the controllers section Terminal answered with', async () => {
  await withRig(async (rig) => {
    const { runId } = await spawnOne(rig);
    const holder = 'controller_019fd400-0000-7000-8000-000000000001' as ControllerAttachmentId;
    rig.terminal.controllerAnswer = {
      attachedCount: 2,
      kinds: ['novakai-shell', 'script'],
      inputLeaseHolder: holder,
    };

    const view = await rig.runtime.getAgentRun(rig.principal(), runId as never);
    assert.equal(view.ok, true);
    if (!view.ok) return;
    assert.deepEqual(view.value.controllers, {
      attachedCount: 2,
      kinds: ['novakai-shell', 'script'],
      inputLeaseHolder: holder,
    });
  });
});

test('zero controllers is a stated fact, and says nothing about the lifecycle', async () => {
  await withRig(async (rig) => {
    const { runId } = await spawnOne(rig);
    rig.terminal.controllerAnswer = { attachedCount: 0, kinds: [] };

    const view = await rig.runtime.getAgentRun(rig.principal(), runId as never);
    assert.equal(view.ok, true);
    if (!view.ok) return;
    assert.equal(view.value.controllers.attachedCount, 0);
    assert.deepEqual(view.value.controllers.kinds, []);
    assert.equal(view.value.controllers.inputLeaseHolder, undefined);
    // §24.5 / FZ-VIEW-004: nobody watching is not stopped, and the launch
    // origin is untouched by the current attachment count.
    assert.notEqual(view.value.run.lifecycle, 'stopped');
    // The composition decides the surface; what matters is that a zero
    // attachment count did not change it.
    assert.equal(view.value.launch.surface, 'novakai-shell');
  });
});

test('when Terminal cannot answer, the read FAILS — "unavailable" is not zero', async () => {
  await withRig(async (rig) => {
    const { runId } = await spawnOne(rig);
    rig.terminal.failControllerFacts = b3err(
      'RuntimeUnavailable', 'Terminal is not answering', {}, true,
    );

    const view = await rig.runtime.getAgentRun(rig.principal(), runId as never);
    // The ratified shape has no unavailable representation, so a fabricated 0
    // would be exactly the lie §24.5 and FZ-VIEW-010 forbid. Fail the read.
    assert.equal(view.ok, false, 'the view was assembled from an unanswered Terminal');
    if (view.ok) return;
    assert.equal(view.error.code, 'RuntimeUnavailable');
  });
});

test('controllerState:"attached" selects only Runs with a controller connected', async () => {
  await withRig(async (rig) => {
    await spawnOne(rig);
    rig.terminal.controllerAnswer = { attachedCount: 1, kinds: ['novakai-shell'] };

    const attached = await rig.runtime.listAgentRuns(rig.principal(), {
      includeFinal: false, limit: 200, controllerState: 'attached',
    });
    assert.equal(attached.ok, true);
    if (attached.ok) assert.equal(attached.value.items.length, 1);

    const headless = await rig.runtime.listAgentRuns(rig.principal(), {
      includeFinal: false, limit: 200, controllerState: 'headless',
    });
    assert.equal(headless.ok, true);
    if (headless.ok) assert.equal(headless.value.items.length, 0);
  });
});

test('controllerState:"headless" is the exact complement, and both agree with the view', async () => {
  await withRig(async (rig) => {
    await spawnOne(rig);
    rig.terminal.controllerAnswer = { attachedCount: 0, kinds: [] };

    const headless = await rig.runtime.listAgentRuns(rig.principal(), {
      includeFinal: false, limit: 200, controllerState: 'headless',
    });
    assert.equal(headless.ok, true);
    if (!headless.ok) return;
    assert.equal(headless.value.items.length, 1);
    // The filter is checkable from its own results — which is the whole reason
    // item 4 and item 5 are one repair (`"attached"` ⇔ attachedCount > 0).
    assert.equal(headless.value.items[0]!.controllers.attachedCount, 0);

    const attached = await rig.runtime.listAgentRuns(rig.principal(), {
      includeFinal: false, limit: 200, controllerState: 'attached',
    });
    assert.equal(attached.ok, true);
    if (attached.ok) assert.equal(attached.value.items.length, 0);
  });
});

test('an omitted controllerState filters nothing', async () => {
  await withRig(async (rig) => {
    await spawnOne(rig);
    rig.terminal.controllerAnswer = { attachedCount: 0, kinds: [] };

    const all = await rig.runtime.listAgentRuns(rig.principal(), {
      includeFinal: false, limit: 200,
    });
    assert.equal(all.ok, true);
    if (all.ok) assert.equal(all.value.items.length, 1);
  });
});

test('controllerState is conjunctive with the other filter members', async () => {
  await withRig(async (rig) => {
    await spawnOne(rig);
    rig.terminal.controllerAnswer = { attachedCount: 1, kinds: ['novakai-shell'] };

    // Attached, but a launch surface no Run in this rig has: conjunction means
    // the answer is empty, not "matched on one member".
    const none = await rig.runtime.listAgentRuns(rig.principal(), {
      includeFinal: false, limit: 200, controllerState: 'attached', launchSurface: 'script',
    });
    assert.equal(none.ok, true);
    if (none.ok) assert.equal(none.value.items.length, 0);

    const one = await rig.runtime.listAgentRuns(rig.principal(), {
      includeFinal: false, limit: 200, controllerState: 'attached', launchSurface: 'novakai-shell',
    });
    assert.equal(one.ok, true);
    if (one.ok) assert.equal(one.value.items.length, 1);
  });
});
