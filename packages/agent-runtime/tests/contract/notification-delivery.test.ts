import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintClientOpId, mintTraceCorrelationId, notificationInputReservationId,
  type NotificationId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import { createRunsRig } from '../runs-harness.js';

const supervisionContext = (): SystemCommandContext<'sys_supervision'> => ({
  principal: { id: 'sys_supervision', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

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

test('a safe-boundary delivery excludes a concurrent provider turn start', async () => {
  const rig = createRunsRig();
  const reservationEntered = gate();
  const releaseReservation = gate();
  try {
    const roleProfileId = rig.agents.defineRole('notification-turn-race-target');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId,
      displayName: 'Notification turn race target',
      workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const notificationId = `notification_${'e'.repeat(52)}` as NotificationId;
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
      inputText: 'Do not race the normal turn',
    });
    rig.terminal.duringNextNotificationReservation = async () => {
      reservationEntered.open();
      await releaseReservation.promise;
    };

    const delivery = rig.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(), input,
    );
    await reservationEntered.promise;
    const normalTurn = rig.runtime.beginProviderTurn(rig.human(), {
      agentRunId: spawned.value.run.id,
      expectedRecordVersion: spawned.value.run.recordVersion,
    });
    const concurrentResult = await Promise.race([
      normalTurn.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => {
        setTimeout(() => { resolve('blocked'); }, 250);
      }),
    ]);
    releaseReservation.open();

    const [submitted, begun] = await Promise.all([delivery, normalTurn]);
    assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.message);
    assert.equal(begun.ok, true, begun.ok ? '' : begun.error.message);
    assert.equal(concurrentResult, 'blocked',
      'a normal provider turn entered while Notification delivery held the Run boundary');
  } finally {
    releaseReservation.open();
    rig.close();
  }
});

test('the query adopts a Supervision claim whose Runtime stage write crashed', async () => {
  const healthy = createRunsRig();
  let crashed: ReturnType<typeof createRunsRig> | null = null;
  try {
    const roleProfileId = healthy.agents.defineRole('claim-recovery-target');
    const spawned = await healthy.runtime.spawnAgent(healthy.human(), {
      roleProfileId,
      displayName: 'Claim recovery target',
      workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const notificationId = `notification_${'b'.repeat(52)}` as NotificationId;
    const effectKey = `b3v4:notification-delivery:${notificationId}:condition`;
    healthy.notifications.authorize({
      notificationId,
      agentRunId: spawned.value.run.id,
      effectKey,
      activityGeneration: spawned.value.run.activityGeneration,
      inputText: 'Status requested',
    });
    crashed = createRunsRig({
      root: healthy.root,
      agents: healthy.agents,
      terminal: healthy.terminal,
      providers: healthy.providers,
      notifications: healthy.notifications,
      messagingEndpoint: healthy.messagingEndpoint,
      transcriptCustody: healthy.transcriptCustody,
      // Open operation, journal intent + its retained occurrence event, then
      // journal Terminal reservation + its retained event. Die on the write
      // that would journal Supervision's already-durable claim.
      crashAfterWrites: 5,
    });

    const interrupted = await crashed.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(),
      {
        notificationId,
        agentRunId: spawned.value.run.id,
        effectKey,
        expectedActivityGeneration: spawned.value.run.activityGeneration,
      },
    );
    assert.equal(interrupted.ok, false, 'fault injection did not interrupt the operation');
    if (!interrupted.ok) assert.equal(interrupted.error.code, 'StoreUnavailable');

    const recovered = await crashed.runtime.getNotificationTurnSubmission(
      crashed.principal(), effectKey,
    );
    assert.equal(recovered.ok, true, recovered.ok ? '' : recovered.error.message);
    if (recovered.ok) {
      assert.deepEqual(recovered.value, {
        state: 'claimed-pending-submission',
        notificationInputReservationId: notificationInputReservationId(effectKey),
        notificationId,
      });
    }
  } finally {
    crashed?.close();
    healthy.close();
  }
});

test('a completed delivery replay survives a later Run generation', async () => {
  const rig = createRunsRig();
  try {
    const roleProfileId = rig.agents.defineRole('delivery-replay-target');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId,
      displayName: 'Delivery replay target',
      workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const notificationId = `notification_${'c'.repeat(52)}` as NotificationId;
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
      inputText: 'Replay-safe notification',
    });
    const prepared = { spawned: spawned.value, input, effectKey };
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

test('restart records Supervision outcome after Terminal committed before a crash', async () => {
  const healthy = createRunsRig();
  let crashed: ReturnType<typeof createRunsRig> | null = null;
  let resumed: ReturnType<typeof createRunsRig> | null = null;
  try {
    const roleProfileId = healthy.agents.defineRole('terminal-commit-recovery-target');
    const spawned = await healthy.runtime.spawnAgent(healthy.human(), {
      roleProfileId,
      displayName: 'Terminal commit recovery target',
      workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const notificationId = `notification_${'d'.repeat(52)}` as NotificationId;
    const effectKey = `b3v4:notification-delivery:${notificationId}:condition`;
    const input = {
      notificationId,
      agentRunId: spawned.value.run.id,
      effectKey,
      expectedActivityGeneration: spawned.value.run.activityGeneration,
    };
    healthy.notifications.authorize({
      ...input,
      activityGeneration: input.expectedActivityGeneration,
      inputText: 'Recover the owner outcome',
    });
    crashed = createRunsRig({
      root: healthy.root,
      agents: healthy.agents,
      terminal: healthy.terminal,
      providers: healthy.providers,
      notifications: healthy.notifications,
      messagingEndpoint: healthy.messagingEndpoint,
      transcriptCustody: healthy.transcriptCustody,
      // Each Runtime stage now durably retains its exact event. The sixth
      // write journals Supervision's claim and the seventh retains that event;
      // Terminal then commits, and terminal-input-submitted crashes.
      crashAfterWrites: 7,
    });
    const interrupted = await crashed.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(), input,
    );
    assert.equal(interrupted.ok, false, 'fault injection did not interrupt the operation');
    if (!interrupted.ok) assert.equal(interrupted.error.code, 'StoreUnavailable');
    assert.equal(healthy.notifications.submissions.length, 0,
      'Supervision outcome unexpectedly landed before the injected crash');

    resumed = createRunsRig({
      root: healthy.root,
      agents: healthy.agents,
      terminal: healthy.terminal,
      providers: healthy.providers,
      notifications: healthy.notifications,
      messagingEndpoint: healthy.messagingEndpoint,
      transcriptCustody: healthy.transcriptCustody,
    });
    const booted = await resumed.runtime.reconcileAfterRestart();
    assert.equal(booted.ok, true, booted.ok ? '' : booted.error.message);
    const interruptedRun = await resumed.runtime.getAgentRun(
      resumed.principal(), spawned.value.run.id,
    );
    assert.equal(interruptedRun.ok, true, interruptedRun.ok ? '' : interruptedRun.error.message);
    if (interruptedRun.ok) assert.equal(interruptedRun.value.run.lifecycle, 'interrupted');
    const recovered = await resumed.runtime.startNotificationTurnAtSafeBoundary(
      supervisionContext(), input,
    );
    assert.equal(recovered.ok, true, recovered.ok ? '' : recovered.error.message);
    assert.equal(healthy.notifications.submissions.length, 1,
      'recovery returned Terminal truth without recording Supervision outcome');
  } finally {
    resumed?.close();
    crashed?.close();
    healthy.close();
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
