import {
  b3fail, b3ok, validationFailed,
  type B3Page, type B3Result, type EventCursor,
} from './b3.js';

interface KeysetItem {
  readonly createdAt: string;
  readonly id: string;
}

const encode = (item: KeysetItem): EventCursor => Buffer.from(JSON.stringify([
  'b3v4-keyset', item.createdAt, item.id,
]), 'utf8').toString('base64url') as EventCursor;

function decode(cursor: EventCursor): readonly [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Array.isArray(parsed) && parsed.length === 3 && parsed[0] === 'b3v4-keyset'
      && typeof parsed[1] === 'string' && typeof parsed[2] === 'string'
      ? [parsed[1], parsed[2]] : null;
  } catch {
    return null;
  }
}

/** Stable `(createdAt,id)` keyset pagination shared by all B3 owner queries. */
export function keysetPage<T extends KeysetItem>(
  values: readonly T[],
  input: { readonly cursor?: EventCursor; readonly limit: number },
): B3Result<B3Page<T>> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    return b3fail(validationFailed([{ path: 'limit', message: 'must be from 1 through 200' }]));
  }
  const cursor = input.cursor === undefined ? null : decode(input.cursor);
  if (input.cursor !== undefined && cursor === null) {
    return b3fail(validationFailed([{ path: 'cursor', message: 'must be an opaque B3 keyset cursor' }]));
  }
  const ordered = [...values].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const after = cursor === null ? ordered : ordered.filter((item) =>
    item.createdAt > cursor[0]
    || (item.createdAt === cursor[0] && item.id > cursor[1]));
  const items = after.slice(0, input.limit);
  const more = after.length > items.length;
  return b3ok({
    items,
    ...(more && items.length > 0 ? { nextCursor: encode(items[items.length - 1]!) } : {}),
    omissions: [],
  });
}
