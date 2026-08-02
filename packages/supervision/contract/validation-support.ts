import {
  b3fail,
  b3ok,
  isValidClientOpId,
  isValidId,
  validationFailed,
  type B3Result,
  type IdFormat,
} from '@novakai/foundation/contract';

/** Internal issue shape shared by Supervision runtime validators. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Runtime object view after rejecting arrays and null. */
export type ObjectValue = Readonly<Record<string, unknown>>;

/** Read an object and accumulate a typed boundary issue on mismatch. */
export function objectValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return {};
  }
  return value as ObjectValue;
}

/** Require one literal value. */
export function exact(
  value: unknown,
  expected: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value !== expected) issues.push({ path, message: `must be ${String(expected)}` });
}

/** Require a non-empty string. */
export function nonEmpty(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'must be a non-empty string' });
  }
}

/** Require an ISO-8601 UTC timestamp. */
export function isoUtc(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    issues.push({ path, message: 'must be an ISO-8601 UTC timestamp' });
  }
}

/** Require a whole number at or above the specified floor. */
export function wholeNumber(
  value: unknown,
  least: number,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Number.isInteger(value) || (value as number) < least) {
    issues.push({ path, message: `must be a whole number at least ${least}` });
  }
}

/** Require a branded identifier's runtime prefix and format. */
export function identifier(
  value: unknown,
  prefix: string,
  format: IdFormat,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isValidId(value, prefix, format)) {
    issues.push({ path, message: `must be a ${prefix} identifier` });
  }
}

/** Require one value from a string vocabulary. */
export function oneOf(
  value: unknown,
  allowed: readonly unknown[],
  path: string,
  issues: ValidationIssue[],
): void {
  if (!allowed.includes(value)) {
    issues.push({ path, message: `must be one of: ${allowed.map(String).join(', ')}` });
  }
}

/** Require an array of strings. */
export function stringArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issues.push({ path, message: 'must be an array of strings' });
  }
}

function forbidden(
  object: ObjectValue,
  fields: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const field of fields) {
    if (object[field] !== undefined) {
      issues.push({ path: `${path}.${field}`, message: 'must be absent' });
    }
  }
}

function mutationProvenance(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  const mutation = objectValue(value, path, issues);
  if (mutation.state === 'trace-complete') {
    identifier(mutation.serverOpId, 'srv', 'uuidv4', `${path}.serverOpId`, issues);
    if (!isValidClientOpId(mutation.clientOpId)) {
      issues.push({ path: `${path}.clientOpId`, message: 'must be an op identifier' });
    }
    identifier(mutation.traceId, 'trace', 'uuidv4', `${path}.traceId`, issues);
    isoUtc(mutation.committedAt, `${path}.committedAt`, issues);
    return;
  }
  if (mutation.state === 'object-appended-trace-missing') {
    identifier(mutation.serverOpId, 'srv', 'uuidv4', `${path}.serverOpId`, issues);
    if (!isValidClientOpId(mutation.clientOpId)) {
      issues.push({ path: `${path}.clientOpId`, message: 'must be an op identifier' });
    }
    forbidden(mutation, ['traceId', 'committedAt'], path, issues);
    return;
  }
  if (mutation.state === 'legacy-no-trace') {
    forbidden(mutation, ['serverOpId', 'clientOpId', 'traceId', 'committedAt'], path, issues);
    return;
  }
  issues.push({ path: `${path}.state`, message: 'is not a mutation provenance state' });
}

/** Validate the exact §4.3 public record envelope and provenance union. */
export function recordEnvelope(
  record: ObjectValue,
  expectedKind: string,
  idPrefix: string,
  idFormat: IdFormat,
  issues: ValidationIssue[],
): void {
  identifier(record.id, idPrefix, idFormat, 'id', issues);
  exact(record.kind, expectedKind, 'kind', issues);
  exact(record.schemaVersion, 1, 'schemaVersion', issues);
  wholeNumber(record.recordVersion, 1, 'recordVersion', issues);
  isoUtc(record.createdAt, 'createdAt', issues);
  oneOf(record.permissionLevel, ['private', 'team', 'external'], 'permissionLevel', issues);
  nonEmpty(record.createdBy, 'createdBy', issues);
  mutationProvenance(record.lastMutation, 'lastMutation', issues);
}

/** Return a validated candidate or the standard typed validation failure. */
export function finish<Value>(
  candidate: unknown,
  issues: readonly ValidationIssue[],
): B3Result<Value> {
  return issues.length === 0
    ? b3ok(candidate as Value)
    : b3fail(validationFailed(issues));
}
