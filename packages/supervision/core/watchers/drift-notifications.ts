import {
  b3fail,
  b3ok,
  deriveClientOpId,
  type B3Result,
  type IsoUtc,
} from '@novakai/foundation/contract';
import {
  deriveNotificationId,
  DRIFT_STATUS_PROMPT,
  notificationDeliveryEffectKey,
  SUPERVISION_RECORD_WRITER,
  type DurableDriftState,
  type Notification,
} from '../../contract/index.js';
import type { Persisted } from '../store.js';
import {
  type CurrentDrift,
  type DriftDependencies,
  type DriftEvidenceObservation,
  watcherConflict,
} from './drift-support.js';

type EpisodeId = NonNullable<DurableDriftState['episodeId']>;

function statusNotificationRecord(
  current: CurrentDrift,
  observed: DriftEvidenceObservation,
  episodeId: EpisodeId,
  createdAt: IsoUtc,
): Persisted<Notification> & Record<string, unknown> {
  const notificationId = deriveNotificationId({
    watchRuleId: current.rule.id,
    subjectKey: current.deadline.subjectKey,
    condition: current.rule.condition,
    activityGeneration: current.deadline.activityGeneration,
    episodeId,
    phase: 'drift-status-request',
  });
  const effectKey = notificationDeliveryEffectKey(notificationId, episodeId);
  return {
    kind: 'notification',
    id: notificationId,
    schemaVersion: 1,
    createdAt,
    permissionLevel: 'private',
    createdBy: SUPERVISION_RECORD_WRITER,
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: current.rule.id,
    subject: current.rule.subject,
    recipient: { kind: 'agent', agentId: observed.agentId },
    conditionGeneration: Number(current.deadline.activityGeneration),
    summary: DRIFT_STATUS_PROMPT,
    evidenceRefs: observed.evidenceRefs,
    state: 'queued',
    deliveryMode: 'start-turn',
    phase: 'drift-status-request',
    driftEpisodeId: episodeId,
  };
}

export async function ensureStatusNotification(
  deps: DriftDependencies,
  current: CurrentDrift,
  observed: DriftEvidenceObservation,
  episodeId: EpisodeId,
  createdAt: IsoUtc,
): Promise<B3Result<Notification>> {
  const record = statusNotificationRecord(current, observed, episodeId, createdAt);
  const existing = await deps.store.read<Notification>('notification', record.id);
  if (!existing.ok) return b3fail(existing.error);
  if (existing.value !== null) {
    const matches = existing.value.phase === 'drift-status-request'
      && existing.value.driftEpisodeId === episodeId
      && existing.value.deliveryEffectKey === record.deliveryEffectKey;
    return matches
      ? b3ok(existing.value)
      : b3fail(watcherConflict('the drift status notification identity is occupied', {
        notificationId: record.id,
        episodeId,
      }));
  }
  return deps.store.create<Notification>(
    SUPERVISION_RECORD_WRITER,
    record,
    deriveClientOpId('b3v4:queue-drift-status:' + record.id),
  );
}

function humanEscalationRecord(
  current: CurrentDrift,
  episodeId: EpisodeId,
  evidenceRefs: readonly string[],
  createdAt: IsoUtc,
): Persisted<Notification> & Record<string, unknown> {
  const notificationId = deriveNotificationId({
    watchRuleId: current.rule.id,
    subjectKey: current.deadline.subjectKey,
    condition: current.rule.condition,
    activityGeneration: current.deadline.activityGeneration,
    episodeId,
    phase: 'drift-human-escalation',
  });
  const effectKey = notificationDeliveryEffectKey(notificationId, episodeId);
  return {
    kind: 'notification',
    id: notificationId,
    schemaVersion: 1,
    createdAt,
    permissionLevel: 'private',
    createdBy: SUPERVISION_RECORD_WRITER,
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: current.rule.id,
    subject: current.rule.subject,
    recipient: current.rule.recipient,
    conditionGeneration: Number(current.deadline.activityGeneration),
    summary: 'Activity drift requires human attention for ' + current.deadline.subjectKey,
    evidenceRefs,
    state: 'queued',
    deliveryMode: current.rule.deliveryMode,
    phase: 'drift-human-escalation',
    driftEpisodeId: episodeId,
  };
}

export async function ensureHumanEscalation(
  deps: DriftDependencies,
  current: CurrentDrift,
  episodeId: EpisodeId,
  evidenceRefs: readonly string[],
  createdAt: IsoUtc,
): Promise<B3Result<Notification>> {
  const record = humanEscalationRecord(current, episodeId, evidenceRefs, createdAt);
  const existing = await deps.store.read<Notification>('notification', record.id);
  if (!existing.ok) return b3fail(existing.error);
  if (existing.value !== null) {
    const matches = existing.value.phase === 'drift-human-escalation'
      && existing.value.driftEpisodeId === episodeId
      && existing.value.deliveryEffectKey === record.deliveryEffectKey;
    return matches
      ? b3ok(existing.value)
      : b3fail(watcherConflict('the human escalation identity is occupied', {
        notificationId: record.id,
        episodeId,
      }));
  }
  return deps.store.create<Notification>(
    SUPERVISION_RECORD_WRITER,
    record,
    deriveClientOpId('b3v4:queue-drift-human-escalation:' + record.id),
  );
}

export async function expireQueuedNotification(
  deps: DriftDependencies,
  outstanding: Extract<
    Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>['outstandingStatus'],
    { readonly state: 'queued' }
  >,
): Promise<B3Result<Notification>> {
  const stored = await deps.store.read<Notification>('notification', outstanding.notificationId);
  if (!stored.ok) return b3fail(stored.error);
  if (stored.value === null) {
    return b3fail(watcherConflict('the queued drift status notification is missing', {
      notificationId: outstanding.notificationId,
      effectKey: outstanding.effectKey,
    }));
  }
  if (stored.value.state === 'expired') return b3ok(stored.value);
  const stillQueued = stored.value.deliveryEffectKey === outstanding.effectKey
    && stored.value.deliveryAttempt.state === 'queued'
    && stored.value.state === 'queued';
  if (!stillQueued) {
    return b3fail(watcherConflict(
      'the status request was claimed while movement was being recorded',
      {
        notificationId: outstanding.notificationId,
        notificationState: stored.value.state,
        deliveryState: stored.value.deliveryAttempt.state,
      },
    ));
  }
  return deps.store.update<Notification>(
    SUPERVISION_RECORD_WRITER,
    stored.value.id,
    { state: 'expired' },
    stored.value.recordVersion,
    deriveClientOpId('b3v4:cancel-queued-drift-status:' + stored.value.id),
  );
}
