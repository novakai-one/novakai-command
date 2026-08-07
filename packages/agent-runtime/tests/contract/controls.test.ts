// Controls on a live Run (§12.1, B3R-006/025, red gate 21).
//
// The point of these is that a control has THREE honest answers and the wrong
// design collapses them into two. "I cannot do that in place" is not a failure
// and it is not permission to restart the Agent — it is a plan handed back to
// whoever asked, who then decides whether losing the Agent's current work is
// worth the change.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RecordVersion } from '@novakai/foundation/contract';
import { createRunsRig, type RunsRig } from '../runs-harness.js';

async function withRig<T>(work: (rig: RunsRig) => Promise<T>): Promise<T> {
  const rig = createRunsRig();
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

/** One live Run, plus the version a caller would have read off it. */
async function oneRun(rig: RunsRig): Promise<{ runId: never; version: RecordVersion }> {
  const role = rig.agents.defineRole('worker');
  const spawned = await rig.runtime.spawnAgent(rig.human(), {
    roleProfileId: role as never,
    displayName: 'Worker',
    workingDirectory: '/tmp/work',
    task: { kind: 'supervised' as const, brief: 'do the thing' },
  });
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
  if (!spawned.ok) throw new Error('unreachable');
  return {
    runId: spawned.value.run.id as never,
    version: spawned.value.run.recordVersion,
  };
}

test('a supported control is applied in place, and reaches Agents exactly as asked', async () => {
  await withRig(async (rig) => {
    const run = await oneRun(rig);
    const outcome = await rig.runtime.applyRunControl(rig.human(), {
      agentRunId: run.runId,
      expectedRunVersion: run.version,
      control: { name: 'model', value: 'opus-next' },
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error.message);
    if (!outcome.ok) return;
    assert.equal(outcome.value.kind, 'applied-native');
    assert.deepEqual(rig.agents.controlsApplied, [{ name: 'model', value: 'opus-next' }],
      'the Runtime must forward the control, not reinterpret it');
  });
});

test('a control that cannot be applied in place returns a plan — and changes nothing', async () => {
  await withRig(async (rig) => {
    const run = await oneRun(rig);
    const before = await rig.runtime.getAgentRun(rig.human().principal, run.runId);
    const outcome = await rig.runtime.applyRunControl(rig.human(), {
      agentRunId: run.runId,
      expectedRunVersion: run.version,
      control: { name: 'effort', value: 'max' },
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error.message);
    if (!outcome.ok || outcome.value.kind !== 'replacement-required') {
      assert.fail(`expected replacement-required, got ${outcome.ok ? outcome.value.kind : 'a failure'}`);
    }
    assert.ok(outcome.value.replacementPlanId, 'the caller is given the plan, not a restart');

    // The Agent is still doing whatever it was doing. Nothing restarted it.
    const after = await rig.runtime.getAgentRun(rig.human().principal, run.runId);
    assert.equal(after.ok && before.ok && after.value.run.id, before.ok ? before.value.run.id : '');
    assert.equal(after.ok && after.value.run.lifecycle,
      before.ok ? before.value.run.lifecycle : '');
  });
});

test('an unsupported control says so, with the reason, instead of pretending', async () => {
  await withRig(async (rig) => {
    const run = await oneRun(rig);
    const outcome = await rig.runtime.applyRunControl(rig.human(), {
      agentRunId: run.runId,
      expectedRunVersion: run.version,
      control: { name: 'provider-setting', value: 'telepathy' },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.value.kind !== 'unsupported') {
      assert.fail('an unsupported control must not read as applied');
    }
    assert.match(outcome.value.reason, /telepathy/);
  });
});

test('a control against a version the caller did not read is refused, and never forwarded', async () => {
  await withRig(async (rig) => {
    const run = await oneRun(rig);
    const stale = (run.version - 1) as RecordVersion;
    const outcome = await rig.runtime.applyRunControl(rig.human(), {
      agentRunId: run.runId,
      expectedRunVersion: stale,
      control: { name: 'model', value: 'opus-next' },
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.code, 'VersionConflict');
    assert.deepEqual(rig.agents.controlsApplied, [],
      'a refused control must not reach Agents at all');
  });
});

test('a caller without control authority is refused before Agents is asked', async () => {
  await withRig(async (rig) => {
    const run = await oneRun(rig);
    const outcome = await rig.runtime.applyRunControl(rig.human([]), {
      agentRunId: run.runId,
      expectedRunVersion: run.version,
      control: { name: 'model', value: 'opus-next' },
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.code, 'PermissionDenied');
    assert.deepEqual(rig.agents.controlsApplied, []);
  });
});

test('discovery reports what the provider can do, and needs the same authority', async () => {
  await withRig(async (rig) => {
    const run = await oneRun(rig);
    const report = await rig.runtime.discoverRunControls(rig.human().principal, {
      agentRunId: run.runId,
    });
    assert.equal(report.ok, true, report.ok ? '' : report.error.message);
    if (!report.ok) return;
    assert.equal(report.value.agentRunId, run.runId);
    const names = report.value.controls.map((control) => control.name);
    assert.deepEqual(names, ['model', 'effort']);
    // The honest part: a control that needs a replacement says so BEFORE anyone
    // tries it, so a caller never has to discover that by failing.
    assert.equal(report.value.controls[1]?.support, 'replacement-required');

    const refused = await rig.runtime.discoverRunControls(rig.human([]).principal, {
      agentRunId: run.runId,
    });
    assert.equal(refused.ok, false);
  });
});
