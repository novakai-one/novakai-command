import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  b3ok, deriveClientOpId, mintClientOpId, mintTraceCorrelationId,
  notificationInputReservationId,
  type ActivityGeneration, type AgentId, type AgentRunId, type AuthenticatedPrincipal,
  type ProviderSessionId,
} from '@novakai/foundation/contract';
import {
  mintWatchRuleId,
  type Notification, type NotificationDeliveryFenceOperation, type WatchRule,
} from '../contract/index.js';
import { conditionNotification } from '../core/condition-notifications.js';
import { rebindDeliveryFences } from '../core/delivery-fences.js';
import { claimNotificationDelivery } from '../core/notifications/delivery.js';
import { createSupervisionStore } from '../core/store.js';

const AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as AgentId;
const SOURCE_RUN = 'agentRun_019fd000-0000-7000-8000-0000000000a1' as AgentRunId;
const REPLACEMENT_RUN = 'agentRun_019fd000-0000-7000-8000-0000000000a2' as AgentRunId;
const SECOND_REPLACEMENT = 'agentRun_019fd000-0000-7000-8000-0000000000a3' as AgentRunId;
const SESSION_ID = 'sess_123e4567-e89b-42d3-a456-426614174000' as ProviderSessionId;
const principal: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};

test('replacement delivery rebinds a same-Run baseline and never compares generations across Runs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-delivery-fence-'));
  try {
    const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
    const ruleResult = await store.create<WatchRule>('sys_supervision', {
      kind: 'watchRule',
      id: mintWatchRuleId(),
      schemaVersion: 1,
      createdAt: '2026-08-04T00:00:00.000Z' as never,
      permissionLevel: 'private',
      createdBy: 'sys_supervision',
      subject: { kind: 'agent', agentId: AGENT_ID },
      condition: { kind: 'run-final' },
      recipient: { kind: 'human', principalId: 'person_chris' as never },
      deliveryMode: 'next-turn-context',
      cooldownMs: 0,
      status: 'active',
    }, mintClientOpId());
    assert.equal(ruleResult.ok, true);
    if (!ruleResult.ok) return;
    const rule = ruleResult.value;
    const created = await store.create<Notification>('sys_supervision', conditionNotification(
      'sys_supervision',
      rule,
      `agent:${String(AGENT_ID)}`,
      99 as ActivityGeneration,
      'event_source_final',
      {
        occurrenceIdentity: 'agent-run',
        qualifiedAt: '2026-08-04T00:00:00.000Z' as never,
        conditionOccurrence: {
          kind: 'run-final',
          agentRunId: SOURCE_RUN,
          providerSessionId: SESSION_ID,
          qualifyingEvidenceRef: 'event_source_final',
          qualifiedAt: '2026-08-04T00:00:00.000Z' as never,
        },
      },
    ), deriveClientOpId('seed-fenced-notification'));
    assert.equal(created.ok, true);
    if (!created.ok) return;

    let currentRun: AgentRunId | null = null;
    const runs = {
      getUsageRun: async () => b3ok({
        agentRunId: SOURCE_RUN, agentId: AGENT_ID, providerSessionId: SESSION_ID, final: true,
      }),
      listUsageRuns: async () => b3ok([]),
      resolveCurrentRunByAgent: async () => b3ok(currentRun === null ? null : {
        agentRunId: currentRun,
        agentId: AGENT_ID,
        providerSessionId: SESSION_ID,
        lifecycle: 'ready' as const,
        final: false,
        activityGeneration: 1 as ActivityGeneration,
        recordVersion: 1 as never,
      }),
    };

    const noLive = await rebindDeliveryFences({ store, runs }, principal, {
      eventId: 'event_source_final',
      kind: 'agent.run.lifecycle.changed',
      occurredAt: '2026-08-04T00:00:00.000Z',
    });
    assert.equal(noLive.ok, true);
    let operations = await store.list<NotificationDeliveryFenceOperation>(
      'notificationDeliveryFenceOperation',
    );
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    assert.equal(operations.value.length, 1);
    assert.equal(operations.value[0]!.state, 'queued-no-live-run');

    currentRun = REPLACEMENT_RUN;
    const continued = await rebindDeliveryFences({ store, runs }, principal, {
      eventId: 'event_replacement_ready',
      kind: 'agent.run.lifecycle.changed',
      occurredAt: '2026-08-04T00:01:00.000Z',
    });
    assert.equal(continued.ok, true);
    let notification = await store.read<Notification>('notification', created.value.id);
    assert.equal(notification.ok, true);
    if (!notification.ok || notification.value?.schemaVersion !== 2) return;
    assert.deepEqual(notification.value.deliveryFence, {
      targetAgentRunId: REPLACEMENT_RUN,
      baselineActivityGeneration: 1,
      boundAt: '2026-08-04T00:01:00.000Z',
    });

    currentRun = SECOND_REPLACEMENT;
    const replacedAgain = await rebindDeliveryFences({ store, runs }, principal, {
      eventId: 'event_replacement_final',
      kind: 'agent.run.lifecycle.changed',
      occurredAt: '2026-08-04T00:02:00.000Z',
    });
    assert.equal(replacedAgain.ok, true);
    notification = await store.read<Notification>('notification', created.value.id);
    assert.equal(notification.ok, true);
    if (!notification.ok || notification.value?.schemaVersion !== 2) return;
    assert.equal(notification.value.deliveryFence?.targetAgentRunId, SECOND_REPLACEMENT);
    assert.equal(notification.value.deliveryFence?.baselineActivityGeneration, 1);
    operations = await store.list<NotificationDeliveryFenceOperation>(
      'notificationDeliveryFenceOperation',
    );
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    assert.equal(operations.value.length, 2);
    assert.equal(operations.value.every((operation) => operation.state === 'completed'), true);

    const reservation = notificationInputReservationId(
      notification.value.deliveryEffectKey,
    ) as never;
    const wrongSourceGeneration = await claimNotificationDelivery({ store }, {
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(),
      traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, {
      notificationId: notification.value.id,
      expectedNotificationRecordVersion: notification.value.recordVersion,
      expectedEffectKey: notification.value.deliveryEffectKey,
      notificationInputReservationId: reservation,
      expectedActivityGeneration: 99 as ActivityGeneration,
    });
    assert.equal(wrongSourceGeneration.ok, false);
    if (!wrongSourceGeneration.ok) {
      assert.equal(wrongSourceGeneration.error.code, 'IdempotencyConflict');
    }
    const exactTargetBaseline = await claimNotificationDelivery({ store }, {
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(),
      traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, {
      notificationId: notification.value.id,
      expectedNotificationRecordVersion: notification.value.recordVersion,
      expectedEffectKey: notification.value.deliveryEffectKey,
      notificationInputReservationId: reservation,
      expectedActivityGeneration: 1 as ActivityGeneration,
    });
    assert.equal(exactTargetBaseline.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
