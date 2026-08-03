import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintClientOpId, mintTraceCorrelationId,
  type NotificationId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import { createRunsRig } from '../runs-harness.js';

const supervisionContext = (): SystemCommandContext<'sys_supervision'> => ({
  principal: { id: 'sys_supervision', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

async function target(
  rig: ReturnType<typeof createRunsRig>, suffix: string,
  semanticSource: 'watcher-status-request' | 'notification-start-turn' = 'notification-start-turn',
) {
  const roleProfileId = rig.agents.defineRole(`notification-${suffix}`);
  const spawned = await rig.runtime.spawnAgent(rig.human(), {
    roleProfileId, displayName: `Notification ${suffix}`, workingDirectory: '/tmp/work',
  });
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
  if (!spawned.ok) throw new Error('spawn failed');
  const notificationId = `notification_${suffix.repeat(52).slice(0, 52)}` as NotificationId;
  const effectKey = `b3v4:notification-delivery:${notificationId}:condition`;
  const input = {
    notificationId,
    agentRunId: spawned.value.run.id,
    effectKey,
    expectedActivityGeneration: spawned.value.run.activityGeneration,
  };
  rig.notifications.authorize({
    ...input,
    activityGeneration: input.expectedActivityGeneration,
    inputText: `Semantic ${suffix} turn`,
    semanticSource,
  });
  return { spawned: spawned.value, input, effectKey };
}

test('an unseen Notification delivery effect has durable state absent', async () => {
  const rig = createRunsRig();
  try {
    const found = await rig.runtime.getNotificationTurnSubmission(
      rig.principal(), 'b3v4:notification-delivery:notification_missing:condition',
    );
    assert.equal(found.ok, true, found.ok ? '' : found.error.message);
    if (found.ok) assert.deepEqual(found.value, { state: 'absent' });
  } finally {
    rig.close();
  }
});

test('a start-turn Notification uses one semantic Runtime submission and replays it', async () => {
  const rig = createRunsRig();
  try {
    const prepared = await target(rig, 'a');
    const first = await rig.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(), prepared.input,
    );
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    if (!first.ok) return;
    assert.equal(first.value.state, 'submitted-confirmed');
    const replay = await rig.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(), prepared.input,
    );
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    if (replay.ok) assert.deepEqual(replay.value, first.value);
    assert.equal(rig.notifications.claims.length, 1);
    assert.equal(rig.notifications.submissions.length, 1);
    const listed = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
      agentRunId: prepared.spawned.run.id, includeTerminal: true, limit: 20,
    });
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.value.items.length, 1);
      assert.equal(listed.value.items[0]!.origin.kind, 'runtime-effect');
      if (listed.value.items[0]!.origin.kind === 'runtime-effect') {
        assert.equal(listed.value.items[0]!.origin.source, 'notification-start-turn');
        assert.equal(listed.value.items[0]!.origin.sourceObjectRef, prepared.input.notificationId);
      }
    }
  } finally {
    rig.close();
  }
});

test('a watcher status request retains its distinct governed source identity', async () => {
  const rig = createRunsRig();
  try {
    const prepared = await target(rig, 'b', 'watcher-status-request');
    const submitted = await rig.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(), prepared.input,
    );
    assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.message);
    const listed = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
      agentRunId: prepared.spawned.run.id, includeTerminal: true, limit: 20,
    });
    assert.equal(listed.ok, true);
    if (listed.ok && listed.value.items[0]?.origin.kind === 'runtime-effect') {
      assert.equal(listed.value.items[0].origin.source, 'watcher-status-request');
    }
  } finally {
    rig.close();
  }
});

test('a held controller boundary leaves a start-turn Notification and Run unchanged', async () => {
  const rig = createRunsRig();
  try {
    const prepared = await target(rig, 'c');
    rig.terminal.providerTurnPrepareBlocked = true;
    const before = await rig.runtime.getAgentRun(rig.principal(), prepared.spawned.run.id);
    assert.equal(before.ok, true);
    const blocked = await rig.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(), prepared.input,
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, 'ProviderTurnOperationInProgress');
    assert.equal(rig.notifications.claims.length, 0);
    assert.equal(rig.notifications.submissions.length, 0);
    const after = await rig.runtime.getAgentRun(rig.principal(), prepared.spawned.run.id);
    assert.equal(after.ok, true);
    if (before.ok && after.ok) {
      assert.equal(after.value.run.activityGeneration, before.value.run.activityGeneration);
      assert.equal(after.value.run.activeProviderTurn, before.value.run.activeProviderTurn);
      assert.equal(after.value.run.providerTurnOperationFence,
        before.value.run.providerTurnOperationFence);
    }
    const remembered = await rig.runtime.getNotificationTurnSubmission(
      rig.principal(), prepared.effectKey,
    );
    assert.equal(remembered.ok, true);
    if (remembered.ok) assert.equal(remembered.value.state, 'reserved-not-claimed');
  } finally {
    rig.close();
  }
});
