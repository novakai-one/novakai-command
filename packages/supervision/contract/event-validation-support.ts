import { isValidId, type IdFormat } from '@novakai/foundation/contract';

export interface EventValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type EventObject = Readonly<Record<string, unknown>>;

export function eventObject(
  value: unknown,
  path: string,
  issues: EventValidationIssue[],
): EventObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return {};
  }
  return value as EventObject;
}

export function exact(
  value: unknown,
  expected: unknown,
  path: string,
  issues: EventValidationIssue[],
): void {
  if (value !== expected) issues.push({ path, message: `must be ${String(expected)}` });
}

export function nonEmpty(value: unknown, path: string, issues: EventValidationIssue[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'must be a non-empty string' });
    return '';
  }
  return value;
}

export function isoUtc(value: unknown, path: string, issues: EventValidationIssue[]): void {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    issues.push({ path, message: 'must be an ISO-8601 UTC timestamp' });
  }
}

export function wholeNumber(
  value: unknown,
  path: string,
  issues: EventValidationIssue[],
): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    issues.push({ path, message: 'must be a non-negative whole number' });
  }
}

export function stringArray(
  value: unknown,
  path: string,
  issues: EventValidationIssue[],
): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issues.push({ path, message: 'must be an array of strings' });
  }
}

/** Runtime predicate for §4.1 opaque URL-safe event cursors. */
export function isUrlSafeEventCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]+$/.test(value);
}

export function eventId(
  value: unknown,
  prefix: string,
  format: IdFormat,
  path: string,
  issues: EventValidationIssue[],
): void {
  if (!isValidId(value, prefix, format)) {
    issues.push({ path, message: `must be a ${prefix} identifier` });
  }
}

export function eventEnvelope(
  candidate: unknown,
  kind: string,
  owner: string,
  issues: EventValidationIssue[],
): EventObject {
  const event = eventObject(candidate, 'event', issues);
  nonEmpty(event.eventId, 'eventId', issues);
  exact(event.kind, kind, 'kind', issues);
  exact(event.schemaVersion, 1, 'schemaVersion', issues);
  isoUtc(event.occurredAt, 'occurredAt', issues);
  isoUtc(event.committedAt, 'committedAt', issues);
  exact(event.sourceOwner, owner, 'sourceOwner', issues);
  eventId(event.traceId, 'trace', 'uuidv4', 'traceId', issues);
  if (!isUrlSafeEventCursor(event.cursor)) {
    issues.push({ path: 'cursor', message: 'must be a non-empty URL-safe string' });
  }
  return event;
}
