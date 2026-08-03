import {
  b3err, b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type AuthenticatedPrincipal, type B3PrincipalId, type B3Result,
} from '@novakai/foundation/contract';
import {
  deriveNotificationDeliveryFenceOperationId, subjectKey,
  type Notification, type NotificationDeliveryFenceOperation,
  type NotificationDeliveryFence,
} from '../contract/index.js';
import type { SupervisionStore } from './store.js';
import type { UsageRunReader } from './usage/index.js';

export interface DeliveryFenceDependencies {
  readonly store: SupervisionStore;
  readonly runs?: UsageRunReader;
}

export interface DeliveryFenceTrigger {
  readonly eventId: string;
  readonly kind: string;
  readonly occurredAt: string;
}

function sourceRun(notification: Notification): string | null {
  if (notification.schemaVersion === 2
    && notification.occurrenceIdentity !== 'legacy-generation') {
    return String(notification.conditionOccurrence.agentRunId);
  }
  return notification.subject.kind === 'agent-run'
    ? String(notification.subject.agentRunId)
    : null;
}

function fenceOf(notification: Notification): NotificationDeliveryFence | undefined {
  return notification.schemaVersion === 2 && notification.phase === 'condition'
    ? notification.deliveryFence
    : undefined;
}

const incomplete = (operation: NotificationDeliveryFenceOperation): boolean =>
  operation.state === 'running'
    || operation.state === 'queued-no-live-run'
    || operation.state === 'recovery-required';

async function operationFor(
  store: SupervisionStore,
  notification: Notification,
  trigger: DeliveryFenceTrigger,
): Promise<B3Result<NotificationDeliveryFenceOperation>> {
  const operations = await store.list<NotificationDeliveryFenceOperation>(
    'notificationDeliveryFenceOperation',
  );
  if (!operations.ok) return operations;
  const prior = operations.value
    .filter((operation) => operation.notificationId === notification.id && incomplete(operation))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))
      || String(left.id).localeCompare(String(right.id)))[0];
  if (prior !== undefined) return b3ok(prior);
  const id = deriveNotificationDeliveryFenceOperationId(notification.id, trigger.eventId);
  const exact = await store.read<NotificationDeliveryFenceOperation>(
    'notificationDeliveryFenceOperation', id,
  );
  if (!exact.ok) return exact;
  if (exact.value !== null) return b3ok(exact.value);
  return store.create<NotificationDeliveryFenceOperation>('sys_supervision' as B3PrincipalId, {
    kind: 'notificationDeliveryFenceOperation',
    id,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: 'sys_supervision',
    notificationId: notification.id,
    ...(fenceOf(notification) === undefined
      ? {}
      : { previousTargetAgentRunId: fenceOf(notification)!.targetAgentRunId }),
    triggerEventId: trigger.eventId,
    state: 'running',
  }, deriveClientOpId(`b3v4:start-delivery-fence-operation:${String(id)}`));
}

async function settleOperation(
  store: SupervisionStore,
  operation: NotificationDeliveryFenceOperation,
  patch: Readonly<Record<string, unknown>>,
): Promise<B3Result<NotificationDeliveryFenceOperation>> {
  return store.update<NotificationDeliveryFenceOperation>(
    'sys_supervision', operation.id, patch, operation.recordVersion,
    deriveClientOpId(
      `b3v4:settle-delivery-fence-operation:${String(operation.id)}`
        + `:${String(patch['state'])}:${String(patch['targetAgentRunId'] ?? '-')}`,
    ),
  );
}

async function rebindOne(
  deps: DeliveryFenceDependencies,
  principal: AuthenticatedPrincipal,
  notification: Notification,
  trigger: DeliveryFenceTrigger,
): Promise<B3Result<null>> {
  if (notification.subject.kind !== 'agent') return b3ok(null);
  const operation = await operationFor(deps.store, notification, trigger);
  if (!operation.ok) return operation;
  if (deps.runs?.resolveCurrentRunByAgent === undefined) {
    const reason = 'Runtime current-Run authority is not composed';
    const failed = await settleOperation(deps.store, operation.value, {
      state: 'recovery-required', reason,
    });
    return failed.ok
      ? b3fail(b3err(
          'RecoveryRequired', reason,
          { operationId: operation.value.id, stage: 'delivery-fence-rebind', reason }, true,
        ))
      : failed;
  }
  const current = await deps.runs.resolveCurrentRunByAgent(
    principal, notification.subject.agentId,
  );
  if (!current.ok) {
    const reason = current.error.message;
    const failed = await settleOperation(deps.store, operation.value, {
      state: 'recovery-required', reason,
    });
    return failed.ok ? b3fail(current.error) : failed;
  }
  if (current.value === null) {
    const queued = await settleOperation(deps.store, operation.value, {
      state: 'queued-no-live-run',
      previousTargetAgentRunId: fenceOf(notification)?.targetAgentRunId,
      targetAgentRunId: undefined,
      reason: undefined,
    });
    return queued.ok ? b3ok(null) : queued;
  }

  const sourceAgentRunId = sourceRun(notification);
  const sameSource = sourceAgentRunId === String(current.value.agentRunId);
  const unchanged = sameSource
    ? fenceOf(notification) === undefined
    : fenceOf(notification)?.targetAgentRunId === current.value.agentRunId;
  let written = notification;
  if (!unchanged) {
    const rebound = await deps.store.update<Notification>(
      'sys_supervision',
      notification.id,
      {
        deliveryFence: sameSource ? undefined : {
          targetAgentRunId: current.value.agentRunId,
          baselineActivityGeneration: current.value.activityGeneration,
          boundAt: trigger.occurredAt,
        },
      },
      notification.recordVersion,
      deriveClientOpId(
        `b3v4:rebind-notification:${String(notification.id)}`
          + `:${String(current.value.agentRunId)}:${trigger.eventId}`,
      ),
    );
    if (!rebound.ok) return rebound;
    written = rebound.value;
  }
  const settled = await settleOperation(deps.store, operation.value, {
    state: 'completed',
    previousTargetAgentRunId: fenceOf(notification)?.targetAgentRunId,
    targetAgentRunId: sameSource
      ? current.value.agentRunId
      : fenceOf(written)?.targetAgentRunId,
    reason: undefined,
  });
  return settled.ok ? b3ok(null) : settled;
}

/** Rebind every queued stable-Agent next-turn delivery after one lifecycle edge. */
export async function rebindDeliveryFences(
  deps: DeliveryFenceDependencies,
  principal: AuthenticatedPrincipal,
  trigger: DeliveryFenceTrigger,
): Promise<B3Result<null>> {
  if (trigger.kind !== 'agent.run.lifecycle.changed') return b3ok(null);
  const notifications = await deps.store.list<Notification>('notification');
  if (!notifications.ok) return notifications;
  const candidates = notifications.value.filter((notification) =>
    notification.phase === 'condition'
    && notification.schemaVersion === 2
    && notification.deliveryMode === 'next-turn-context'
    && notification.deliveryAttempt.state === 'queued'
    && notification.subject.kind === 'agent');
  for (const notification of candidates) {
    const rebound = await rebindOne(deps, principal, notification, trigger);
    if (!rebound.ok) return rebound;
  }
  return b3ok(null);
}

export function deliveryFenceScope(notification: Notification): string {
  return `${String(notification.watchRuleId)}:${subjectKey(notification.subject)}`;
}
