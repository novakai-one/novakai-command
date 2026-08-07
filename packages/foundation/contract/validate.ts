// Runtime validation at a boundary (B3V4-P2 §3.2, §4.2).
//
// Brands are compile-time assistance and casts are erased, so a payload that
// arrives over a socket has exactly the shape it claims and no more. §4.2 is a
// MUST: "Every store, CLI, and wire boundary MUST also run the matching runtime
// validator." This is the machinery those validators are written with — the
// rules themselves live with the capability that owns the shape.
//
// Two deliberate properties: a boundary reports EVERY problem it found, not the
// first; and reading a field that is wrong still returns something, so a
// validator reads like the shape it is describing instead of a chain of guards.
import { isValidId, validationFailed, type IdFormat } from './b3.js';
import { b3fail, b3ok, type B3Result } from './b3.js';

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export interface FieldReader {
  /** Everything wrong with the payload so far. */
  readonly issues: readonly FieldIssue[];
  /** Record a problem this reader cannot express — a union tag, say. */
  reject(path: string, message: string): void;
  /** The value as it arrived, for a shape only the capability can judge. */
  given(path: string): unknown;
  id<Id extends string>(path: string, prefix: string, format?: IdFormat): Id;
  optionalId<Id extends string>(path: string, prefix: string, format?: IdFormat): Id | undefined;
  text(path: string): string;
  optionalText(path: string): string | undefined;
  choice<Value extends string>(path: string, allowed: readonly Value[]): Value;
  optionalChoice<Value extends string>(
    path: string, allowed: readonly Value[],
  ): Value | undefined;
  count(path: string, least: number, most: number): number;
  optionalCount(path: string, least: number, most: number): number | undefined;
  /** A nested object, with its issue paths kept fully qualified. */
  nested(path: string): FieldReader;
}

const NOT_AN_OBJECT = 'must be an object';

function createReader(
  candidate: unknown, issues: FieldIssue[], prefix: string,
): FieldReader {
  const body = (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate))
    ? candidate as Record<string, unknown>
    : null;
  if (body === null && prefix !== '') issues.push({ path: prefix.slice(0, -1), message: NOT_AN_OBJECT });

  const note = (path: string, message: string): void => {
    issues.push({ path: `${prefix}${path}`, message });
  };
  const given = (path: string): unknown => body?.[path];

  const requiredText = (path: string): string => {
    const value = given(path);
    if (typeof value !== 'string' || value.trim() === '') {
      note(path, 'must be a non-empty string');
      return '';
    }
    return value;
  };

  const requiredCount = (path: string, least: number, most: number): number => {
    const value = given(path);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < least || value > most) {
      note(path, `must be a whole number between ${least} and ${most}`);
      return least;
    }
    return value;
  };

  const requiredId = <Id extends string>(
    path: string, idPrefix: string, format: IdFormat,
  ): Id => {
    const value = given(path);
    if (!isValidId(value, idPrefix, format)) {
      // Named, because "invalid id" hides the whole point: it is the WRONG KIND.
      note(path, `must be a ${idPrefix} identifier`);
      return '' as Id;
    }
    return value as Id;
  };

  const requiredChoice = <Value extends string>(
    path: string, allowed: readonly Value[],
  ): Value => {
    const value = given(path);
    if (typeof value !== 'string' || !allowed.includes(value as Value)) {
      note(path, `must be one of: ${allowed.join(', ')}`);
      return allowed[0]!;
    }
    return value as Value;
  };

  return {
    issues,
    reject: note,
    given,
    id<Id extends string>(path: string, idPrefix: string, format: IdFormat = 'uuidv7'): Id {
      return requiredId<Id>(path, idPrefix, format);
    },
    optionalId<Id extends string>(
      path: string, idPrefix: string, format: IdFormat = 'uuidv7',
    ): Id | undefined {
      return given(path) === undefined ? undefined : requiredId<Id>(path, idPrefix, format);
    },
    text: requiredText,
    optionalText: (path) => (given(path) === undefined ? undefined : requiredText(path)),
    choice<Value extends string>(path: string, allowed: readonly Value[]): Value {
      return requiredChoice<Value>(path, allowed);
    },
    optionalChoice<Value extends string>(
      path: string, allowed: readonly Value[],
    ): Value | undefined {
      return given(path) === undefined ? undefined : requiredChoice<Value>(path, allowed);
    },
    count: requiredCount,
    optionalCount: (path, least, most) =>
      (given(path) === undefined ? undefined : requiredCount(path, least, most)),
    nested: (path) => createReader(given(path), issues, `${prefix}${path}.`),
  };
}

/**
 * Read a boundary payload into the shape the contract promises, or fail with
 * every reason it could not be read. `build` describes the shape; it never has
 * to check anything itself.
 */
export function readBoundary<Value>(
  candidate: unknown, build: (field: FieldReader) => Value,
): B3Result<Value> {
  const issues: FieldIssue[] = [];
  const reader = createReader(candidate, issues, '');
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return b3fail(validationFailed([{ path: 'payload', message: NOT_AN_OBJECT }]));
  }
  const value = build(reader);
  if (issues.length > 0) return b3fail(validationFailed(issues));
  return b3ok(value);
}
