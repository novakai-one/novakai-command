// Q7 — Agent Runtime owns durable Notification delivery orchestration.
//
// These tests stay on the public Runtime interface. Terminal and Supervision
// vary through the same ports production composition uses; the test never
// reaches Runtime's store or delivery implementation directly.
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

test('a safe-boundary command submits one Notification turn and remembers its outcome', async () => {
  const rig = createRunsRig();
  try {
    const roleProfileId = rig.agents.defineRole('notification-target');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId,
      displayName: 'Notification target',
      workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const notificationId = `notification_${'a'.repeat(52)}` as NotificationId;
    const effectKey = `b3v4:notification-delivery:${notificationId}:condition`;
    rig.notifications.authorize({
      notificationId,
      agentRunId: spawned.value.run.id,
      effectKey,
      activityGeneration: spawned.value.run.activityGeneration,
      inputText: 'Output token threshold reached',
    });

    const submitted = await rig.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(),
      {
        notificationId,
        agentRunId: spawned.value.run.id,
        effectKey,
        expectedActivityGeneration: spawned.value.run.activityGeneration,
      },
    );

    assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.message);
    if (!submitted.ok) return;
    assert.equal(submitted.value.state, 'submitted-confirmed');
    const remembered = await rig.runtime.getNotificationTurnSubmission(
      rig.principal(), effectKey,
    );
    assert.equal(remembered.ok, true, remembered.ok ? '' : remembered.error.message);
    if (remembered.ok) assert.deepEqual(remembered.value, submitted.value);
  } finally {
    rig.close();
  }
});
