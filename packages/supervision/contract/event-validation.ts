import {
  b3fail,
  b3ok,
  isValidId,
  validationFailed,
  type B3Result,
} from '@novakai/foundation/contract';
import type {
  NotificationEvent,
  ProviderUsageEvidenceCommittedEvent,
  PublicEvent,
} from './events.js';
import type { Notification, ProviderUsageEvidence } from './records.js';
import {
  finish,
  recordEnvelope as validateRecordEnvelope,
} from './validation-support.js';

interface Issue {
  readonly path: string;
  readonly message: string;
}

type ObjectValue = Readonly<Record<string, unknown>>;

function objectValue(value: unknown, path: string, issues: Issue[]): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return {};
  }
  return value as ObjectValue;
}

function exact(value: unknown, expected: unknown, path: string, issues: Issue[]): void {
  if (value !== expected) issues.push({ path, message: `must be ${String(expected)}` });
}

function nonEmpty(value: unknown, path: string, issues: Issue[]): void {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'must be a non-empty string' });
  }
}

function isoUtc(value: unknown, path: string, issues: Issue[]): void {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    issues.push({ path, message: 'must be an ISO-8601 UTC timestamp' });
  }
}

function wholeNumber(value: unknown, path: string, issues: Issue[]): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    issues.push({ path, message: 'must be a non-negative whole number' });
  }
}

function stringArray(value: unknown, path: string, issues: Issue[]): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issues.push({ path, message: 'must be an array of strings' });
  }
}

/** Runtime predicate for §4.1 opaque URL-safe event cursors. */
export function isUrlSafeEventCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]+$/.test(value);
}

function id(
  value: unknown,
  prefix: string,
  format: 'uuidv4' | 'uuidv7' | 'base32sha256',
  path: string,
  issues: Issue[],
): void {
  if (!isValidId(value, prefix, format)) {
    issues.push({ path, message: `must be a ${prefix} identifier` });
  }
}

function eventEnvelope(
  candidate: unknown,
  kind: string,
  owner: string,
  issues: Issue[],
): ObjectValue {
  const event = objectValue(candidate, 'event', issues);
  nonEmpty(event.eventId, 'eventId', issues);
  exact(event.kind, kind, 'kind', issues);
  exact(event.schemaVersion, 1, 'schemaVersion', issues);
  isoUtc(event.occurredAt, 'occurredAt', issues);
  isoUtc(event.committedAt, 'committedAt', issues);
  exact(event.sourceOwner, owner, 'sourceOwner', issues);
  id(event.traceId, 'trace', 'uuidv4', 'traceId', issues);
  if (!isUrlSafeEventCursor(event.cursor)) {
    issues.push({ path: 'cursor', message: 'must be a non-empty URL-safe string' });
  }
  return event;
}

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
    nonEmpty(target.principalId, 'payload.recipient.principalId', issues);
  } else {
    issues.push({ path: 'payload.recipient.kind', message: 'is not a recipient kind' });
  }
}

function notificationPayload(value: unknown, issues: Issue[]): void {
  const payload = objectValue(value, 'payload', issues);
  validateRecordEnvelope(payload, 'notification', 'notification', 'base32sha256', issues);
  nonEmpty(payload.deliveryEffectKey, 'payload.deliveryEffectKey', issues);
  const attempt = objectValue(payload.deliveryAttempt, 'payload.deliveryAttempt', issues);
  nonEmpty(attempt.effectKey, 'payload.deliveryAttempt.effectKey', issues);
  if (attempt.effectKey !== payload.deliveryEffectKey) {
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
  if (payload.phase === 'condition') {
    if (payload.driftEpisodeId !== undefined) {
      issues.push({ path: 'payload.driftEpisodeId', message: 'is forbidden for condition phase' });
    }
  } else if (payload.phase === 'drift-status-request'
    || payload.phase === 'drift-human-escalation') {
    id(payload.driftEpisodeId, 'driftEpisode', 'base32sha256', 'payload.driftEpisodeId', issues);
  } else {
    issues.push({ path: 'payload.phase', message: 'is not a notification phase' });
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
