import {
  b3fail,
  b3ok,
  validationFailed,
  type B3Result,
} from '@novakai/foundation/contract';
import type {
  NotificationEvent,
  ProviderUsageEvidenceCommittedEvent,
  PublicEvent,
} from './events.js';
import type { Notification, ProviderUsageEvidence } from './records.js';
import { notificationDeliveryEffectKey } from './identity-derivation.js';
import type { DriftEpisodeId, NotificationId } from './identifiers.js';
import {
  finish,
  recordEnvelope as validateRecordEnvelope,
} from './validation-support.js';
import {
  eventEnvelope,
  eventId as id,
  eventObject as objectValue,
  exact,
  isoUtc,
  isUrlSafeEventCursor,
  nonEmpty,
  stringArray,
  wholeNumber,
  type EventObject as ObjectValue,
  type EventValidationIssue as Issue,
} from './event-validation-support.js';

export { isUrlSafeEventCursor } from './event-validation-support.js';

function providerMeasurement(value: unknown, issues: Issue[]): void {
  const measurement = objectValue(value, 'payload.measurement', issues);
  if (!['measured', 'estimated', 'partial', 'unavailable'].includes(measurement.quality as string)) {
    issues.push({ path: 'payload.measurement.quality', message: 'is not a measurement quality' });
  }
  for (const field of [
    'inputTokens', 'outputTokens', 'cachedInputTokens', 'costMicros', 'providerTurns',
  ] as const) {
    const amount = measurement[field];
    if (amount !== undefined
      && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) {
      issues.push({ path: `payload.measurement.${field}`, message: 'must be non-negative' });
    }
  }
  stringArray(measurement.limitations, 'payload.measurement.limitations', issues);
  nonEmpty(measurement.evidenceDigest, 'payload.measurement.evidenceDigest', issues);
}

/** Parse the Agents usage-evidence event consumed by watcher evaluation. */
export function parseProviderUsageEvidenceCommittedEvent(
  candidate: unknown,
): B3Result<ProviderUsageEvidenceCommittedEvent> {
  const issues: Issue[] = [];
  const event = eventEnvelope(
    candidate,
    'agent.provider-usage-evidence.committed',
    'agents',
    issues,
  );
  const payload = objectValue(event.payload, 'payload', issues);
  validateRecordEnvelope(
    payload,
    'providerUsageEvidence',
    'providerUsage',
    'base32sha256',
    issues,
  );
  id(payload.providerSessionId, 'sess', 'uuidv4', 'payload.providerSessionId', issues);
  if (payload.providerConversationId !== null && typeof payload.providerConversationId !== 'string') {
    issues.push({ path: 'payload.providerConversationId', message: 'must be string or null' });
  }
  isoUtc(payload.observedAt, 'payload.observedAt', issues);
  nonEmpty(payload.source, 'payload.source', issues);
  if (payload.sourceCursor !== undefined) nonEmpty(payload.sourceCursor, 'payload.sourceCursor', issues);
  providerMeasurement(payload.measurement, issues);
  return issues.length === 0
    ? b3ok(candidate as ProviderUsageEvidenceCommittedEvent)
    : b3fail(validationFailed(issues));
}

function subject(value: unknown, issues: Issue[]): void {
  const target = objectValue(value, 'payload.subject', issues);
  if (target.kind === 'agent-run') {
    id(target.agentRunId, 'agentRun', 'uuidv7', 'payload.subject.agentRunId', issues);
  } else if (target.kind === 'agent' || target.kind === 'children-of') {
    id(target.agentId, 'agent', 'uuidv4', 'payload.subject.agentId', issues);
  } else {
    issues.push({ path: 'payload.subject.kind', message: 'is not a WatchSubject kind' });
  }
}

function recipient(value: unknown, issues: Issue[]): void {
  const target = objectValue(value, 'payload.recipient', issues);
  if (target.kind === 'agent') {
    id(target.agentId, 'agent', 'uuidv4', 'payload.recipient.agentId', issues);
  } else if (target.kind === 'human') {
    const principalId = nonEmpty(target.principalId, 'payload.recipient.principalId', issues);
    if (!/^person_[A-Za-z0-9-]+$/.test(principalId)) {
      issues.push({
        path: 'payload.recipient.principalId',
        message: 'must be a Messaging PersonId',
      });
    }
  } else {
    issues.push({ path: 'payload.recipient.kind', message: 'is not a recipient kind' });
  }
}

function notificationPhase(payload: ObjectValue, issues: Issue[]): DriftEpisodeId | undefined {
  if (payload.phase === 'condition') {
    if (payload.driftEpisodeId !== undefined) {
      issues.push({ path: 'payload.driftEpisodeId', message: 'is forbidden for condition phase' });
    }
    return undefined;
  }
  if (payload.phase === 'drift-status-request' || payload.phase === 'drift-human-escalation') {
    id(payload.driftEpisodeId, 'driftEpisode', 'base32sha256', 'payload.driftEpisodeId', issues);
    return payload.driftEpisodeId as DriftEpisodeId;
  }
  issues.push({ path: 'payload.phase', message: 'is not a notification phase' });
  return undefined;
}

function notificationEffectKey(
  payload: ObjectValue,
  driftEpisodeId: DriftEpisodeId | undefined,
  issues: Issue[],
): void {
  if (typeof payload.id !== 'string') return;
  const expectedEffectKey = notificationDeliveryEffectKey(
    payload.id as NotificationId,
    driftEpisodeId,
  );
  if (payload.deliveryEffectKey !== expectedEffectKey) {
    issues.push({
      path: 'payload.deliveryEffectKey',
      message: 'must match the exact Notification/episode delivery key',
    });
  }
}

function notificationDeliveryAttempt(
  value: unknown,
  deliveryEffectKey: unknown,
  issues: Issue[],
): void {
  const attempt = objectValue(value, 'payload.deliveryAttempt', issues);
  nonEmpty(attempt.effectKey, 'payload.deliveryAttempt.effectKey', issues);
  if (attempt.effectKey !== deliveryEffectKey) {
    issues.push({
      path: 'payload.deliveryAttempt.effectKey',
      message: 'must match payload.deliveryEffectKey',
    });
  }
  if (attempt.state === 'delivery-claimed') {
    isoUtc(attempt.claimedAt, 'payload.deliveryAttempt.claimedAt', issues);
    id(
      attempt.notificationInputReservationId,
      'notificationInput',
      'base32sha256',
      'payload.deliveryAttempt.notificationInputReservationId',
      issues,
    );
  } else if (attempt.state === 'submitted-confirmed'
    || attempt.state === 'submitted-unconfirmed') {
    isoUtc(attempt.submittedAt, 'payload.deliveryAttempt.submittedAt', issues);
    id(
      attempt.notificationInputReservationId,
      'notificationInput',
      'base32sha256',
      'payload.deliveryAttempt.notificationInputReservationId',
      issues,
    );
    id(
      attempt.terminalInputAttemptId,
      'terminalInput',
      'uuidv7',
      'payload.deliveryAttempt.terminalInputAttemptId',
      issues,
    );
    if (attempt.state === 'submitted-confirmed') {
      id(attempt.providerTurnId, 'providerTurn', 'uuidv7', 'payload.deliveryAttempt.providerTurnId', issues);
    } else if (attempt.providerTurnId !== undefined) {
      id(attempt.providerTurnId, 'providerTurn', 'uuidv7', 'payload.deliveryAttempt.providerTurnId', issues);
    }
  } else if (attempt.state !== 'queued') {
    issues.push({ path: 'payload.deliveryAttempt.state', message: 'is not a delivery-attempt state' });
  }
}

function notificationPayload(value: unknown, issues: Issue[]): void {
  const payload = objectValue(value, 'payload', issues);
  validateRecordEnvelope(
    payload, 'notification', 'notification', 'base32sha256', issues, [1, 2],
  );
  nonEmpty(payload.deliveryEffectKey, 'payload.deliveryEffectKey', issues);
  notificationDeliveryAttempt(payload.deliveryAttempt, payload.deliveryEffectKey, issues);
  id(payload.watchRuleId, 'watchRule', 'uuidv7', 'payload.watchRuleId', issues);
  subject(payload.subject, issues);
  recipient(payload.recipient, issues);
  wholeNumber(payload.conditionGeneration, 'payload.conditionGeneration', issues);
  nonEmpty(payload.summary, 'payload.summary', issues);
  stringArray(payload.evidenceRefs, 'payload.evidenceRefs', issues);
  if (![
    'queued', 'offered-to-endpoint', 'transcript-observed',
    'acknowledged', 'delivery-uncertain', 'expired',
  ].includes(payload.state as string)) {
    issues.push({ path: 'payload.state', message: 'is not a notification state' });
  }
  if (!['queue-only', 'next-turn-context', 'start-turn'].includes(payload.deliveryMode as string)) {
    issues.push({ path: 'payload.deliveryMode', message: 'is not a delivery mode' });
  }
  notificationEffectKey(payload, notificationPhase(payload, issues), issues);
  if (payload.schemaVersion === 2) {
    exact(payload.phase, 'condition', 'payload.phase', issues);
    isoUtc(payload.qualifiedAt, 'payload.qualifiedAt', issues);
    if (![
      'legacy-generation', 'agent-run', 'committed-event', 'run-operation',
    ].includes(String(payload.occurrenceIdentity))) {
      issues.push({
        path: 'payload.occurrenceIdentity',
        message: 'is not an ordinary occurrence identity',
      });
    }
    if (payload.occurrenceIdentity === 'legacy-generation') {
      if (payload.conditionOccurrence !== undefined) {
        issues.push({
          path: 'payload.conditionOccurrence',
          message: 'is forbidden for legacy-generation identity',
        });
      }
    } else {
      const occurrence = objectValue(
        payload.conditionOccurrence,
        'payload.conditionOccurrence',
        issues,
      );
      id(occurrence.agentRunId, 'agentRun', 'uuidv7', 'payload.conditionOccurrence.agentRunId', issues);
      id(
        occurrence.providerSessionId,
        'sess',
        'uuidv4',
        'payload.conditionOccurrence.providerSessionId',
        issues,
      );
      nonEmpty(
        occurrence.qualifyingEvidenceRef,
        'payload.conditionOccurrence.qualifyingEvidenceRef',
        issues,
      );
      isoUtc(occurrence.qualifiedAt, 'payload.conditionOccurrence.qualifiedAt', issues);
      if (occurrence.qualifiedAt !== payload.qualifiedAt) {
        issues.push({
          path: 'payload.conditionOccurrence.qualifiedAt',
          message: 'must equal payload.qualifiedAt',
        });
      }
      if (payload.occurrenceIdentity === 'agent-run') {
        if (occurrence.kind !== 'agent-run' && occurrence.kind !== 'run-final') {
          issues.push({ path: 'payload.conditionOccurrence.kind', message: 'must be agent-run or run-final' });
        }
      } else if (payload.occurrenceIdentity === 'committed-event') {
        exact(occurrence.kind, 'committed-event', 'payload.conditionOccurrence.kind', issues);
        nonEmpty(occurrence.eventId, 'payload.conditionOccurrence.eventId', issues);
      } else if (payload.occurrenceIdentity === 'run-operation') {
        exact(occurrence.kind, 'run-operation', 'payload.conditionOccurrence.kind', issues);
        id(
          occurrence.runOperationId,
          'runOperation',
          'base32sha256',
          'payload.conditionOccurrence.runOperationId',
          issues,
        );
      }
    }
  } else {
    for (const field of [
      'occurrenceIdentity', 'conditionOccurrence', 'qualifiedAt', 'deliveryFence',
    ]) {
      if (payload[field] !== undefined) {
        issues.push({ path: `payload.${field}`, message: 'is forbidden on schema version 1' });
      }
    }
  }
}

/** Parse the one §15 supervision event with a fully specified payload. */
export function parseNotificationEvent(candidate: unknown): B3Result<NotificationEvent> {
  const issues: Issue[] = [];
  const event = eventEnvelope(
    candidate,
    'supervision.notification.changed',
    'supervision',
    issues,
  );
  notificationPayload(event.payload, issues);
  return issues.length === 0
    ? b3ok(candidate as NotificationEvent)
    : b3fail(validationFailed(issues));
}

/** Parse a Notification record outside its event envelope. */
export function parseNotificationRecord(candidate: unknown): B3Result<Notification> {
  const issues: Issue[] = [];
  notificationPayload(candidate, issues);
  return finish<Notification>(candidate, issues);
}

const CAPABILITY_OWNERS = [
  'foundation', 'agents', 'agent-runtime', 'terminal', 'messaging', 'transcript',
  'supervision', 'shell', 'server', 'projects', 'artifacts', 'spine',
] as const;

/** Parse the generic committed event envelope accepted by evaluateEvent. */
export function parsePublicEvent(
  candidate: unknown,
): B3Result<PublicEvent<string, Readonly<Record<string, unknown>>>> {
  const issues: Issue[] = [];
  const event = objectValue(candidate, 'event', issues);
  nonEmpty(event.eventId, 'eventId', issues);
  nonEmpty(event.kind, 'kind', issues);
  exact(event.schemaVersion, 1, 'schemaVersion', issues);
  isoUtc(event.occurredAt, 'occurredAt', issues);
  isoUtc(event.committedAt, 'committedAt', issues);
  if (!CAPABILITY_OWNERS.includes(event.sourceOwner as never)) {
    issues.push({ path: 'sourceOwner', message: 'is not a capability owner' });
  }
  id(event.traceId, 'trace', 'uuidv4', 'traceId', issues);
  if (!isUrlSafeEventCursor(event.cursor)) {
    issues.push({ path: 'cursor', message: 'must be a non-empty URL-safe string' });
  }
  objectValue(event.payload, 'payload', issues);
  return finish<PublicEvent<string, Readonly<Record<string, unknown>>>>(candidate, issues);
}

/** Runtime narrowing aliases for callers validating payloads separately. */
export type ValidatedNotification = Notification;
export type ValidatedProviderUsageEvidence = ProviderUsageEvidence;
export type ValidatedPublicEvent = PublicEvent<string, Readonly<Record<string, unknown>>>;
