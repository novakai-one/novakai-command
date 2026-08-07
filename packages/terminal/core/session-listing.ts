// A5-05 (B3V4-AMD-005): the paged, filtered session listing behind §12.3's
// `listTerminalSessions`.
//
// Separate from `sessions.ts` because it answers a different question. That
// file owns a session's LIFE — open, settle, terminate. This one owns only
// "which records is this page, and where does the next one start", which is
// the one part of the listing a caller can hold onto and come back with.
import {
  b3fail, b3err, b3ok, validationFailed,
  type B3Result, type EventCursor,
} from '@novakai/foundation/contract';
import type { TerminalSessionFilter } from '../contract/api.js';
import type { TerminalSession, TerminalSessionOwner } from '../contract/records.js';

/** A5-05's list law, shared with every other list method in the build. */
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

const CURSOR_PREFIX = 'terminalSessions.';

interface CursorPosition { readonly createdAt: string; readonly id: string }

/**
 * The opaque keyset position, minted here and read here. A cursor belongs to
 * the stream owner that made it (FZ-EVT-007), and the prefix is exactly what
 * lets a cursor from another listing be refused rather than silently misread
 * as a position in this one.
 */
function cursorFor(session: TerminalSession): EventCursor {
  const encoded = Buffer.from(
    JSON.stringify([session.createdAt, String(session.id)]), 'utf8',
  ).toString('base64url');
  return `${CURSOR_PREFIX}${encoded}` as EventCursor;
}

function readCursor(cursor: EventCursor): B3Result<CursorPosition> {
  try {
    if (!String(cursor).startsWith(CURSOR_PREFIX)) throw new Error('wrong prefix');
    const decoded = JSON.parse(Buffer.from(
      String(cursor).slice(CURSOR_PREFIX.length), 'base64url',
    ).toString('utf8')) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2
      || typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string') {
      throw new Error('wrong tuple');
    }
    return b3ok({ createdAt: decoded[0], id: decoded[1] });
  } catch {
    return b3fail(b3err(
      'ValidationFailed', 'terminal-session cursor is not a Terminal continuation',
      { issues: [{ path: 'cursor', message: 'is malformed or belongs to another query' }] },
      false,
    ));
  }
}

const afterCursor = (session: TerminalSession, from: CursorPosition): boolean =>
  session.createdAt > from.createdAt
  || (session.createdAt === from.createdAt && String(session.id) > from.id);

/** Owners are compared by their whole identity — kind AND the thing it names. */
function sameOwner(left: TerminalSessionOwner, right: TerminalSessionOwner): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'plain-shell' && right.kind === 'plain-shell'
    ? left.shellInstanceId === right.shellInstanceId
    : left.kind === 'agent-run' && right.kind === 'agent-run'
      && left.agentRunId === right.agentRunId;
}

/** Conjunctive: every stated member must hold. */
function matches(session: TerminalSession, filter: TerminalSessionFilter): boolean {
  if (filter.owner !== undefined && !sameOwner(session.owner, filter.owner)) return false;
  return filter.status === undefined || filter.status.includes(session.status);
}

function readLimit(limit: number): B3Result<number> {
  if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    return b3fail(validationFailed([{
      path: 'limit', message: `must be a whole number from ${MIN_LIMIT} to ${MAX_LIMIT}`,
    }]));
  }
  return b3ok(limit);
}

export interface SessionPageWindow {
  readonly wanted: readonly TerminalSession[];
  /** The cursor a caller resumes with, absent when this page is the last one. */
  readonly nextCursor?: EventCursor;
}

/**
 * The page of sessions a filter selects: ordered by the stable `(createdAt,id)`
 * key, resumed after the caller's cursor, filtered, then cut to `limit`.
 *
 * `nextCursor` is minted from the last record in the WINDOW rather than from
 * whatever survives projection later, so a session that a reader cannot be
 * shown still occupies its place in the order and is not handed out twice.
 */
export function sessionPageWindow(
  stored: readonly TerminalSession[], filter: TerminalSessionFilter,
): B3Result<SessionPageWindow> {
  const limit = readLimit(filter.limit);
  if (!limit.ok) return limit;
  const position = filter.cursor === undefined ? b3ok(null) : readCursor(filter.cursor);
  if (!position.ok) return position;
  const from = position.value;

  const matching = [...stored]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || String(left.id).localeCompare(String(right.id)))
    .filter((session) => from === null || afterCursor(session, from))
    .filter((session) => matches(session, filter));

  const wanted = matching.slice(0, limit.value);
  const more = wanted.length < matching.length;
  return b3ok({
    wanted,
    ...(more ? { nextCursor: cursorFor(wanted.at(-1)!) } : {}),
  });
}
