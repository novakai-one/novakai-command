import {
  deterministicId,
  type ActivityGeneration,
  type AgentRunId,
  type CommandReceiptId,
  type RecordVersion,
  type RunOperationId,
} from '@novakai/foundation/contract';
import type {
  DriftEpisodeId,
  NotificationId,
  NotificationInputReservationId,
  NotificationDeliveryFenceOperationId,
  WatchEvaluationId,
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
  /** Absent preserves the byte-for-byte legacy identity. */
  readonly armingOrdinal?: number;
}

/** Deterministically derive one WatchDeadline identity. */
export function deriveWatchDeadlineId(input: WatchDeadlineIdentityInput): WatchDeadlineId {
  if (input.armingOrdinal !== undefined) {
    return deterministicId('watchDeadline', [
      'watch-deadline-arming',
      input.watchRuleId,
      input.subjectKey,
      String(input.activityGeneration),
      String(input.armingOrdinal),
    ]) as WatchDeadlineId;
  }
  return deterministicId('watchDeadline', [
    'watch-deadline',
    input.watchRuleId,
    input.subjectKey,
    String(input.activityGeneration),
  ]) as WatchDeadlineId;
}

/** The three AMD-003 collision-safe ordinary occurrence namespaces. */
export type OccurrenceNotificationIdentityInput = {
  readonly watchRuleId: WatchRuleId;
  readonly subjectKey: string;
  readonly condition: WatchCondition;
  readonly phase: 'condition';
} & (
  | { readonly occurrenceIdentity: 'agent-run'; readonly agentRunId: AgentRunId }
  | { readonly occurrenceIdentity: 'committed-event'; readonly eventId: string }
  | { readonly occurrenceIdentity: 'run-operation'; readonly runOperationId: RunOperationId }
);

/** Derive an AR, EV, or OP ordinary Notification identity. */
export function deriveOccurrenceNotificationId(
  input: OccurrenceNotificationIdentityInput,
): NotificationId {
  const common = [
    input.watchRuleId,
    input.subjectKey,
    canonicalConditionScalar(input.condition),
  ];
  if (input.occurrenceIdentity === 'agent-run') {
    return deterministicId('notification', [
      'notification-agent-run-condition-v1', ...common, input.agentRunId, input.phase,
    ]) as NotificationId;
  }
  if (input.occurrenceIdentity === 'committed-event') {
    return deterministicId('notification', [
      'notification-event-condition-v1', ...common, input.eventId, input.phase,
    ]) as NotificationId;
  }
  return deterministicId('notification', [
    'notification-operation-condition-v1', ...common, input.runOperationId, input.phase,
  ]) as NotificationId;
}

/** Stable evaluation identity for an event receipt. */
export function deriveEventWatchEvaluationId(
  commandReceiptId: CommandReceiptId,
): WatchEvaluationId {
  return deterministicId('watchEvaluation', [
    'watch-evaluation-event', commandReceiptId,
  ]) as WatchEvaluationId;
}

/** Stable evaluation identity for one immutable ordinary arming cycle. */
export function deriveDeadlineWatchEvaluationId(
  watchDeadlineId: WatchDeadlineId,
  deadlineCreationRecordVersion: RecordVersion,
): WatchEvaluationId {
  return deterministicId('watchEvaluation', [
    'watch-evaluation-deadline', watchDeadlineId, String(deadlineCreationRecordVersion),
  ]) as WatchEvaluationId;
}

/** Stable progress identity for rebinding one Notification after one committed trigger. */
export function deriveNotificationDeliveryFenceOperationId(
  notificationId: NotificationId,
  triggerEventId: string,
): NotificationDeliveryFenceOperationId {
  return deterministicId('notificationDeliveryFenceOperation', [
    'notification-delivery-fence-operation', notificationId, triggerEventId,
  ]) as NotificationDeliveryFenceOperationId;
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
