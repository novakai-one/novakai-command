import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  b3err, b3fail, b3ok, commandReceiptId, deriveClientOpId, mintClientOpId,
  mintTraceCorrelationId,
  type ActivityGeneration, type AgentRunId, type IsoUtc, type PublicOperationName,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveDeadlineWatchEvaluationId, deriveNotificationId, notificationDeliveryEffectKey,
  SUPERVISION_RECORD_WRITER,
  type CreateWatchRuleInput, type Notification, type WatchDeadline, type WatchRule,
} from '../../contract/index.js';
import { composeSupervision } from '../../core/compose.js';
import { createSupervisionStore } from '../../core/store.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000d1' as AgentRunId;
const human = {
  id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [],
};
const operator = {
  id: 'ops_deadline' as never,
  kind: 'operations' as const,
  verifiedScopes: ['supervision:watch:repair' as never],
};

function humanContext(clientOpId = mintClientOpId()) {
  return {
    principal: human,
    clientOpId,
    traceId: mintTraceCorrelationId(),
    contractVersion: 1 as const,
  };
}

function schedulerContext(clientOpId = mintClientOpId()): SystemCommandContext<'sys_supervision'> {
  return {
    principal: { id: 'sys_supervision', kind: 'system', verifiedScopes: [] },
    clientOpId,
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

const idleRule = (value: number): CreateWatchRuleInput => ({
  subject: { kind: 'agent-run', agentRunId: RUN_ID },
  condition: { kind: 'idle-for-ms', value },
  recipient: { kind: 'human', principalId: human.id },
  deliveryMode: 'queue-only',
  cooldownMs: 0,
  status: 'active',
});

test('ordinary deadline arming cycles keep immutable identity and isolated progress', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-ordinary-deadline-'));
  try {
    let now = new Date('2026-08-04T00:00:00.000Z');
    const supervision = composeSupervision({
      root,
      dataRoot: path.join(root, 'stores'),
      clock: () => now,
      installAuthority: { resolve: async () => {
        throw new Error('not used');
      } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: {
        generationFor: async () => b3ok(3 as ActivityGeneration),
      },
    });
    const firstRuleResult = await supervision.createWatchRule(humanContext(), idleRule(300_000));
    const secondRuleResult = await supervision.createWatchRule(humanContext(), idleRule(300_000));
    assert.equal(firstRuleResult.ok, true);
    assert.equal(secondRuleResult.ok, true);
    if (!firstRuleResult.ok || !secondRuleResult.ok) return;
    let firstRule: WatchRule = firstRuleResult.value;

    let deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (!deadlines.ok) return;
    assert.equal(deadlines.value.length, 2);
    for (const deadline of deadlines.value) {
      assert.equal(deadline.activityGeneration, 3);
      assert.equal(deadline.armingOrdinal, 0);
      assert.equal(deadline.creationRecordVersion, 1);
      assert.equal(deadline.dueAt, '2026-08-04T00:05:00.000Z');
    }
    const firstDeadline = deadlines.value.find(
      (deadline) => deadline.watchRuleId === firstRule.id,
    )!;
    const immutableIdentity = {
      id: firstDeadline.id,
      activityGeneration: firstDeadline.activityGeneration,
      armingOrdinal: firstDeadline.armingOrdinal,
      dueAt: firstDeadline.dueAt,
      creationRecordVersion: firstDeadline.creationRecordVersion,
    };

    now = new Date('2026-08-04T00:06:00.000Z');
    const claimContext = schedulerContext();
    const claimed = await supervision.claimDueDeadlines(claimContext, {
      dueBefore: now.toISOString() as IsoUtc,
      limit: 10,
      schedulerLeaseMs: 30_000,
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.equal(claimed.value.length, 2);
    const progressAfterClaim = await supervision.listWatchEvaluationProgress(operator, {
      triggerKind: 'deadline', limit: 20,
    });
    assert.equal(progressAfterClaim.ok, true);
    if (!progressAfterClaim.ok) return;
    assert.equal(progressAfterClaim.value.items.length, 2);
    assert.equal(new Set(progressAfterClaim.value.items.map((item) => item.id)).size, 2);
    for (const deadline of claimed.value) {
      const expectedId = deriveDeadlineWatchEvaluationId(
        deadline.id, deadline.creationRecordVersion!,
      );
      assert.equal(progressAfterClaim.value.items.some((item) => item.id === expectedId), true);
    }

    const firstClaim = claimed.value.find((deadline) => deadline.id === firstDeadline.id)!;
    assert.equal(firstClaim.lastMutation.state, 'trace-complete');
    if (firstClaim.lastMutation.state !== 'trace-complete') return;
    now = new Date(Math.max(
      Date.parse(firstClaim.lastMutation.committedAt), Date.parse(firstClaim.dueAt),
    ) + 30_001);
    const restarted = composeSupervision({
      root,
      dataRoot: path.join(root, 'stores'),
      clock: () => now,
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: {
        generationFor: async () => b3ok(3 as ActivityGeneration),
      },
    });
    const reclaimed = await restarted.claimDueDeadlines(schedulerContext(), {
      dueBefore: now.toISOString() as IsoUtc,
      limit: 10,
      schedulerLeaseMs: 30_000,
    });
    assert.equal(reclaimed.ok, true);
    if (!reclaimed.ok) return;
    assert.equal(reclaimed.value.length, 2);
    const reclaimedFirst = reclaimed.value.find(
      (deadline) => deadline.id === firstDeadline.id,
    )!;
    assert.deepEqual({
      id: reclaimedFirst.id,
      activityGeneration: reclaimedFirst.activityGeneration,
      armingOrdinal: reclaimedFirst.armingOrdinal,
      dueAt: reclaimedFirst.dueAt,
      creationRecordVersion: reclaimedFirst.creationRecordVersion,
    }, immutableIdentity);
    assert.ok(Number(reclaimedFirst.recordVersion) > Number(firstClaim.recordVersion));
    const progressAfterReclaim = await restarted.listWatchEvaluationProgress(operator, {
      triggerKind: 'deadline', limit: 20,
    });
    assert.equal(progressAfterReclaim.ok, true);
    if (!progressAfterReclaim.ok) return;
    assert.equal(progressAfterReclaim.value.items.length, 2);
    assert.equal(
      progressAfterReclaim.value.items.find((item) =>
        item.id === deriveDeadlineWatchEvaluationId(
          firstDeadline.id, firstDeadline.creationRecordVersion!,
        ))?.commandReceiptId,
      progressAfterClaim.value.items.find((item) =>
        item.id === deriveDeadlineWatchEvaluationId(
          firstDeadline.id, firstDeadline.creationRecordVersion!,
        ))?.commandReceiptId,
      'a new claim receipt must adopt the original deadline progress identity',
    );

    const fired = await restarted.evaluateDueDeadlines(now.toISOString() as IsoUtc);
    assert.equal(fired.ok, true);
    if (!fired.ok) return;
    assert.equal(fired.value.length, 2);
    deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (!deadlines.ok) return;
    const firedFirst = deadlines.value.find((deadline) => deadline.id === firstDeadline.id)!;
    assert.deepEqual({
      id: firedFirst.id,
      activityGeneration: firedFirst.activityGeneration,
      armingOrdinal: firedFirst.armingOrdinal,
      dueAt: firedFirst.dueAt,
      creationRecordVersion: firedFirst.creationRecordVersion,
    }, immutableIdentity);
    assert.equal(firedFirst.state, 'fired');
    assert.ok(Number(firedFirst.recordVersion) > 1);

    const updateOp = mintClientOpId();
    const shortened = await supervision.updateWatchRule(humanContext(updateOp), {
      watchRuleId: firstRule.id,
      expectedRecordVersion: firstRule.recordVersion,
      replacement: idleRule(60_000),
    });
    assert.equal(shortened.ok, true);
    if (!shortened.ok) return;
    firstRule = shortened.value;
    const updateReplay = await supervision.updateWatchRule(humanContext(updateOp), {
      watchRuleId: firstRule.id,
      expectedRecordVersion: firstRuleResult.value.recordVersion,
      replacement: idleRule(60_000),
    });
    assert.equal(updateReplay.ok, true);

    deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (!deadlines.ok) return;
    const firstRuleDeadlines = deadlines.value.filter(
      (deadline) => deadline.watchRuleId === firstRule.id,
    );
    assert.equal(firstRuleDeadlines.length, 2, 'exact update replay allocated another ordinal');
    const shortenedDeadline = firstRuleDeadlines.find((deadline) => deadline.state === 'armed')!;
    assert.equal(shortenedDeadline.armingOrdinal, 1);
    assert.equal(shortenedDeadline.activityGeneration, 3);
    assert.equal(shortenedDeadline.dueAt, '2026-08-04T00:01:00.000Z');
    assert.notEqual(shortenedDeadline.id, firstDeadline.id);

    const paused = await supervision.updateWatchRule(humanContext(), {
      watchRuleId: firstRule.id,
      expectedRecordVersion: firstRule.recordVersion,
      replacement: { ...idleRule(60_000), status: 'paused' },
    });
    assert.equal(paused.ok, true);
    if (!paused.ok) return;
    const resumed = await supervision.updateWatchRule(humanContext(), {
      watchRuleId: firstRule.id,
      expectedRecordVersion: paused.value.recordVersion,
      replacement: idleRule(60_000),
    });
    assert.equal(resumed.ok, true);
    deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (!deadlines.ok) return;
    const resumedDeadline = deadlines.value.find((deadline) =>
      deadline.watchRuleId === firstRule.id && deadline.state === 'armed')!;
    assert.equal(resumedDeadline.armingOrdinal, 2);
    assert.notEqual(resumedDeadline.id, shortenedDeadline.id);

    const cancelled = await supervision.updateWatchRule(humanContext(), {
      watchRuleId: firstRule.id,
      expectedRecordVersion: resumed.value.recordVersion,
      replacement: {
        ...idleRule(60_000),
        condition: { kind: 'run-final' },
      },
    });
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (!deadlines.ok) return;
    assert.equal(deadlines.value.find((item) => item.id === resumedDeadline.id)?.state, 'superseded');

    const rearmContext = humanContext();
    const rearmed = await supervision.updateWatchRule(rearmContext, {
      watchRuleId: firstRule.id,
      expectedRecordVersion: cancelled.value.recordVersion,
      replacement: idleRule(60_000),
    });
    assert.equal(rearmed.ok, true);
    if (!rearmed.ok) return;
    const rearmReplay = await supervision.updateWatchRule(rearmContext, {
      watchRuleId: firstRule.id,
      expectedRecordVersion: cancelled.value.recordVersion,
      replacement: idleRule(60_000),
    });
    assert.equal(rearmReplay.ok, true);
    deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (!deadlines.ok) return;
    const cancellationRearm = deadlines.value.find((deadline) =>
      deadline.watchRuleId === firstRule.id && deadline.state === 'armed')!;
    assert.equal(cancellationRearm.armingOrdinal, 3);
    assert.equal(deadlines.value.filter((deadline) =>
      deadline.watchRuleId === firstRule.id && deadline.armingOrdinal === 3).length, 1);

    const activityAt = new Date(now.getTime() + 1_000).toISOString() as IsoUtc;
    const activity = await supervision.evaluateEvent({
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(),
      traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, {
      event: {
        eventId: 'event_ordinary_activity_generation_4',
        kind: 'agent.run.activity.changed',
        schemaVersion: 1,
        occurredAt: activityAt,
        committedAt: activityAt,
        sourceOwner: 'agent-runtime',
        traceId: mintTraceCorrelationId(),
        cursor: 'ordinary-activity-generation-4' as never,
        payload: { agentRunId: RUN_ID, activityGeneration: 4 },
      },
    });
    assert.equal(activity.ok, true, activity.ok ? '' : activity.error.message);
    deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (!deadlines.ok) return;
    const activityRearm = deadlines.value.find((deadline) =>
      deadline.watchRuleId === firstRule.id && deadline.state === 'armed')!;
    assert.equal(activityRearm.activityGeneration, 4);
    assert.equal(activityRearm.armingOrdinal, 0);
    assert.equal(
      deadlines.value.find((deadline) => deadline.id === cancellationRearm.id)?.state,
      'superseded',
    );
    assert.notEqual(activityRearm.id, cancellationRearm.id);
    assert.notEqual(
      deriveDeadlineWatchEvaluationId(activityRearm.id, activityRearm.creationRecordVersion!),
      deriveDeadlineWatchEvaluationId(
        cancellationRearm.id, cancellationRearm.creationRecordVersion!,
      ),
    );

    const progressAfterFire = await supervision.listWatchEvaluationProgress(operator, {
      watchRuleId: firstRule.id,
      triggerKind: 'deadline',
      outcomeKind: 'committed',
      limit: 20,
    });
    assert.equal(progressAfterFire.ok, true);
    if (!progressAfterFire.ok) return;
    assert.equal(progressAfterFire.value.items.length, 1);
    assert.equal(progressAfterFire.value.items[0]!.state, 'completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #15: a pre-amendment deadline breach is record-scoped within its claim batch', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-legacy-deadline-'));
  try {
    const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
    const supervision = composeSupervision({
      root,
      dataRoot: path.join(root, 'stores'),
      store,
      clock: () => new Date('2026-08-04T00:10:00.000Z'),
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: { generationFor: async () => b3ok(3 as ActivityGeneration) },
    });
    const rule = await supervision.createWatchRule(humanContext(), idleRule(300_000));
    assert.equal(rule.ok, true);
    if (!rule.ok) return;
    const healthyRule = await supervision.createWatchRule(humanContext(), idleRule(300_000));
    assert.equal(healthyRule.ok, true);
    if (!healthyRule.ok) return;
    const deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (!deadlines.ok) return;
    const deadline: WatchDeadline = deadlines.value.find(
      (candidate) => candidate.watchRuleId === rule.value.id,
    )!;
    const healthyDeadline: WatchDeadline = deadlines.value.find(
      (candidate) => candidate.watchRuleId === healthyRule.value.id,
    )!;
    assert.equal(deadline.creationRecordVersion, 1);
    assert.equal(deadline.armingOrdinal, 0);
    const madeLegacy = await store.update<WatchDeadline>(
      SUPERVISION_RECORD_WRITER,
      deadline.id,
      { creationRecordVersion: undefined, armingOrdinal: undefined },
      deadline.recordVersion,
      deriveClientOpId(`test:make-legacy-deadline:${String(deadline.id)}`),
    );
    assert.equal(madeLegacy.ok, true);
    if (!madeLegacy.ok) return;

    const claimContext = schedulerContext();
    const claim = await supervision.claimDueDeadlines(claimContext, {
      dueBefore: '2026-08-04T00:20:00.000Z' as IsoUtc,
      limit: 10,
      schedulerLeaseMs: 30_000,
    });
    assert.equal(claim.ok, false);
    if (claim.ok) return;
    assert.equal(claim.error.code, 'RecoveryRequired');
    assert.match(claim.error.message, /missing immutable arming identity fields/);
    assert.equal(
      claim.error.details['operationId'],
      commandReceiptId(
        claimContext.principal.id,
        'supervision.claimDueDeadlines' as PublicOperationName,
        claimContext.clientOpId,
      ),
    );
    assert.match(String(claim.error.details['reason']), new RegExp(String(deadline.id)));
    const unchanged = await store.read<WatchDeadline>('watchDeadline', deadline.id);
    assert.equal(unchanged.ok, true);
    if (!unchanged.ok) return;
    assert.equal(unchanged.value?.state, 'armed');
    const healthy = await store.read<WatchDeadline>('watchDeadline', healthyDeadline.id);
    assert.equal(healthy.ok, true);
    if (!healthy.ok) return;
    assert.equal(healthy.value?.state, 'claimed');
    const progress = await supervision.listWatchEvaluationProgress(operator, {
      triggerKind: 'deadline', limit: 20,
    });
    assert.equal(progress.ok, true);
    if (!progress.ok) return;
    assert.equal(progress.value.items.length, 1);
    assert.equal(progress.value.items[0]!.trigger.kind, 'deadline');
    if (progress.value.items[0]!.trigger.kind === 'deadline') {
      assert.equal(progress.value.items[0]!.trigger.watchDeadlineId, healthyDeadline.id);
    }
    assert.notEqual(
      progress.value.items[0]!.id,
      deriveDeadlineWatchEvaluationId(deadline.id, 1 as never),
    );
    const notifications = await supervision.listNotifications(human, { limit: 20 });
    assert.equal(notifications.ok, true);
    if (notifications.ok) assert.equal(notifications.value.items.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #46: deadline non-retryable failure is operator-discoverable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-deadline-terminal-failure-'));
  try {
    const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
    const supervision = composeSupervision({
      root,
      dataRoot: path.join(root, 'stores'),
      store,
      clock: () => new Date('2026-08-04T00:10:00.000Z'),
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: { generationFor: async () => b3ok(3 as ActivityGeneration) },
      usage: {
        runs: {
          getUsageRun: async () => b3fail(b3err(
            'ProviderSessionReservationConflict', 'corrupt Runtime binding', {}, false,
          )),
          listUsageRuns: async () => b3ok([]),
          resolveUsageRunByProviderSession: async () => b3ok(null),
          resolveCurrentRunByAgent: async () => b3ok(null),
          getRunOccurrenceEvent: async () => b3fail(b3err(
            'ProviderSessionReservationConflict', 'corrupt Runtime binding', {
              conflictingAgentRunIds: [RUN_ID],
            }, false,
          )),
        },
        evidence: {
          getProviderUsageEvidence: async () => b3ok(null),
          listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
        },
      },
    });
    const created = await supervision.createWatchRule(humanContext(), idleRule(300_000));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const id = deriveNotificationId({
      watchRuleId: created.value.id,
      subjectKey: `agent-run:${String(RUN_ID)}`,
      condition: created.value.condition,
      activityGeneration: 2 as ActivityGeneration,
      phase: 'condition',
    });
    const effectKey = notificationDeliveryEffectKey(id);
    const seeded = await store.create<Notification>(SUPERVISION_RECORD_WRITER, {
      id,
      kind: 'notification',
      schemaVersion: 1,
      createdAt: '2026-08-03T00:00:00.000Z' as never,
      permissionLevel: 'private',
      createdBy: SUPERVISION_RECORD_WRITER,
      deliveryEffectKey: effectKey,
      deliveryAttempt: { state: 'queued', effectKey },
      watchRuleId: created.value.id,
      subject: created.value.subject,
      recipient: created.value.recipient,
      conditionGeneration: 2,
      summary: 'legacy idle threshold',
      evidenceRefs: ['event_corrupt_runtime_owner'],
      state: 'queued',
      deliveryMode: created.value.deliveryMode,
      phase: 'condition',
    }, deriveClientOpId(`test:seed-terminal-deadline-failure:${String(id)}`));
    assert.equal(seeded.ok, true);

    const evaluated = await supervision.evaluateDueDeadlines(
      '2026-08-04T00:20:00.000Z' as IsoUtc,
    );
    assert.deepEqual(evaluated, b3ok([]));
    const progress = await supervision.listWatchEvaluationProgress(operator, {
      watchRuleId: created.value.id,
      triggerKind: 'deadline',
      outcomeKind: 'failed-non-retryable',
      limit: 20,
    });
    assert.equal(progress.ok, true);
    if (!progress.ok) return;
    assert.equal(progress.value.items.length, 1);
    assert.equal(progress.value.items[0]!.state, 'completed');
    assert.equal(progress.value.items[0]!.completed[0]!.outcome.kind, 'failed-non-retryable');
    const deadlines = await supervision.listWatchDeadlines(operator);
    assert.equal(deadlines.ok, true);
    if (deadlines.ok) assert.equal(deadlines.value[0]!.state, 'fired');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
