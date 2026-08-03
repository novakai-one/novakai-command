import {
  b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type ActivityGeneration, type B3PrincipalId, type B3Result,
} from '@novakai/foundation/contract';
import {
  deriveNotificationId, notificationDeliveryEffectKey,
  type Notification, type WatchRule,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';

interface QueueDependencies {
  readonly store: SupervisionStore;
}

/** Build the one stable Notification for a non-drift condition generation. */
export function conditionNotification(
  principal: B3PrincipalId,
  rule: WatchRule,
  keyedSubject: string,
  activityGeneration: ActivityGeneration,
  evidenceRef: string,
): Persisted<Notification> & Record<string, unknown> {
  const notificationId = deriveNotificationId({
    watchRuleId: rule.id,
    subjectKey: keyedSubject,
    condition: rule.condition,
    activityGeneration,
    phase: 'condition',
  });
  const effectKey = notificationDeliveryEffectKey(notificationId);
  return {
    kind: 'notification',
    id: notificationId,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: principal,
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: rule.id,
    subject: rule.subject,
    recipient: rule.recipient,
    conditionGeneration: Number(activityGeneration),
    summary: `${rule.condition.kind} fired for ${keyedSubject}`,
    evidenceRefs: [evidenceRef],
    state: 'queued',
    deliveryMode: rule.deliveryMode,
    phase: 'condition',
  };
}

/** Queue a pre-built Notification exactly once under its deterministic ID. */
export async function queueConditionNotification(
  deps: QueueDependencies,
  principal: B3PrincipalId,
  record: Persisted<Notification> & Record<string, unknown>,
): Promise<B3Result<Notification | null>> {
  const existing = await deps.store.read<Notification>('notification', record.id);
  if (!existing.ok) return b3fail(existing.error);
  if (existing.value !== null) return b3ok(null);
  const written = await deps.store.create<Notification>(
    principal, record, deriveClientOpId(`b3v4:queue-notification:${record.id}`),
  );
  return written.ok ? b3ok(written.value) : b3fail(written.error);
}
