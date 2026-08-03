import {
  b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type ActivityGeneration, type B3PrincipalId, type B3Result, type IsoUtc,
} from '@novakai/foundation/contract';
import {
  deriveNotificationId, deriveOccurrenceNotificationId, notificationDeliveryEffectKey,
  type ConditionOccurrence, type Notification, type WatchRule,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';

interface QueueDependencies {
  readonly store: SupervisionStore;
}

export type ConditionNotificationOccurrence =
  | { readonly occurrenceIdentity: 'legacy-generation'; readonly qualifiedAt: IsoUtc }
  | {
      readonly occurrenceIdentity: 'agent-run';
      readonly conditionOccurrence: Extract<
        ConditionOccurrence,
        { readonly kind: 'agent-run' | 'run-final' }
      >;
      readonly qualifiedAt: IsoUtc;
    }
  | {
      readonly occurrenceIdentity: 'committed-event';
      readonly conditionOccurrence: Extract<ConditionOccurrence, { readonly kind: 'committed-event' }>;
      readonly qualifiedAt: IsoUtc;
    }
  | {
      readonly occurrenceIdentity: 'run-operation';
      readonly conditionOccurrence: Extract<ConditionOccurrence, { readonly kind: 'run-operation' }>;
      readonly qualifiedAt: IsoUtc;
    };

/** Build the one stable Notification for a non-drift condition generation. */
export function conditionNotification(
  principal: B3PrincipalId,
  rule: WatchRule,
  keyedSubject: string,
  activityGeneration: ActivityGeneration,
  evidenceRef: string,
  occurrence: ConditionNotificationOccurrence,
): Persisted<Notification> & Record<string, unknown> {
  const notificationId = occurrence.occurrenceIdentity === 'legacy-generation'
    ? deriveNotificationId({
        watchRuleId: rule.id,
        subjectKey: keyedSubject,
        condition: rule.condition,
        activityGeneration,
        phase: 'condition',
      })
    : deriveOccurrenceNotificationId(
        occurrence.occurrenceIdentity === 'agent-run'
          ? {
              watchRuleId: rule.id,
              subjectKey: keyedSubject,
              condition: rule.condition,
              phase: 'condition',
              occurrenceIdentity: 'agent-run',
              agentRunId: occurrence.conditionOccurrence.agentRunId,
            }
          : occurrence.occurrenceIdentity === 'committed-event'
            ? {
                watchRuleId: rule.id,
                subjectKey: keyedSubject,
                condition: rule.condition,
                phase: 'condition',
                occurrenceIdentity: 'committed-event',
                eventId: occurrence.conditionOccurrence.eventId,
              }
            : {
                watchRuleId: rule.id,
                subjectKey: keyedSubject,
                condition: rule.condition,
                phase: 'condition',
                occurrenceIdentity: 'run-operation',
                runOperationId: occurrence.conditionOccurrence.runOperationId,
              },
      );
  const effectKey = notificationDeliveryEffectKey(notificationId);
  return {
    kind: 'notification',
    id: notificationId,
    schemaVersion: 2,
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
    ...occurrence,
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
