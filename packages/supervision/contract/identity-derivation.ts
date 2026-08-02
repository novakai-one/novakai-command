import { deterministicId, type ActivityGeneration } from '@novakai/foundation/contract';
import type {
  DriftEpisodeId,
  NotificationId,
  NotificationInputReservationId,
  WatchDeadlineId,
  WatchRuleId,
} from './identifiers.js';
import type { WatchCondition, WatchSubject } from './records.js';

/** Exact Q3 subject-address mapping; display names never enter deterministic identity. */
export function subjectKey(subject: WatchSubject): string {
  switch (subject.kind) {
    case 'agent': return `agent:${String(subject.agentId)}`;
    case 'agent-run': return `agent-run:${String(subject.agentRunId)}`;
    case 'children-of': return `children-of:${String(subject.agentId)}`;
  }
}

/** Terminal's deterministic reservation identity for one delivery effect. */
export function deriveNotificationInputReservationId(
  deliveryEffectKey: string,
): NotificationInputReservationId {
  return deterministicId('notificationInput', [
    'notification-input',
    deliveryEffectKey,
  ]) as NotificationInputReservationId;
}

/** RFC 8785 canonical JSON for the complete WatchCondition scalar. */
export function canonicalConditionScalar(condition: WatchCondition): string {
  return canonicalJson(condition);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('canonical JSON rejects unsupported values');
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((propertyName) => {
    const item = record[propertyName];
    if (item === undefined) throw new TypeError('canonical JSON rejects undefined values');
    return `${JSON.stringify(propertyName)}:${canonicalJson(item)}`;
  }).join(',')}}`;
}

/** Exact Q3 tuple for one generation-fenced WatchDeadline. */
export interface WatchDeadlineIdentityInput {
  readonly watchRuleId: WatchRuleId;
  readonly subjectKey: string;
  readonly activityGeneration: ActivityGeneration;
}

/** Deterministically derive one WatchDeadline identity. */
export function deriveWatchDeadlineId(input: WatchDeadlineIdentityInput): WatchDeadlineId {
  return deterministicId('watchDeadline', [
    'watch-deadline',
    input.watchRuleId,
    input.subjectKey,
    String(input.activityGeneration),
  ]) as WatchDeadlineId;
}

/** Exact scalar tuple fixed by §9.2 step 3 for one drift episode. */
export interface DriftEpisodeIdentityInput {
  readonly watchRuleId: WatchRuleId;
  readonly subjectKey: string;
  readonly activityGeneration: ActivityGeneration;
  readonly fingerprint: string;
  readonly episodeOrdinal: number;
}

/** Canonical §4.1/§9.2 drift-episode identity derivation. */
export function deriveDriftEpisodeId(input: DriftEpisodeIdentityInput): DriftEpisodeId {
  return deterministicId('driftEpisode', [
    'drift-episode',
    input.watchRuleId,
    input.subjectKey,
    String(input.activityGeneration),
    input.fingerprint,
    String(input.episodeOrdinal),
  ]) as DriftEpisodeId;
}

/** The exact logical tuple fixed by Q3 for one condition or drift phase. */
export interface NotificationIdentityTuple {
  readonly watchRuleId: WatchRuleId;
  readonly subjectKey: string;
  readonly condition: WatchCondition;
  readonly activityGeneration: ActivityGeneration;
  readonly episodeId?: DriftEpisodeId;
  readonly phase: 'condition' | 'drift-status-request' | 'drift-human-escalation';
}

/** Deterministically derive a Notification identity using Q3's complete tuple. */
export function deriveNotificationId(input: NotificationIdentityTuple): NotificationId {
  const episode = input.phase === 'condition' ? '-' : input.episodeId;
  if (episode === undefined) {
    throw new TypeError('a drift Notification identity requires an episodeId');
  }
  return deterministicId('notification', [
    'notification',
    input.watchRuleId,
    input.subjectKey,
    canonicalConditionScalar(input.condition),
    String(input.activityGeneration),
    episode,
    input.phase,
  ]) as NotificationId;
}

/** Exact Q7 effect key stored before any Notification delivery effect. */
export function notificationDeliveryEffectKey(
  notificationId: NotificationId,
  driftEpisodeId?: DriftEpisodeId,
): string {
  return `b3v4:notification-delivery:${String(notificationId)}:${
    driftEpisodeId === undefined ? 'condition' : String(driftEpisodeId)
  }`;
}
