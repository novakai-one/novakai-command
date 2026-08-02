// The public event stream (§15, §12.2 `subscribeRunEvents`).
//
// Events are NOT durable records: §18.1's store inventory has no events file,
// and inventing one would make Agent Runtime the writer of a kind no capability
// owns. So this is a bounded in-process log, and its cursor says so — a cursor
// minted by an earlier Runtime is `CursorExpired` with a typed gap rather than
// a silent resume at "now" (§15, and §20's last row).
//
// The log is what makes an external consumer possible at all. Before it, thirty
// event kinds were published into a function that dropped them, and a second
// host could only poll (hold-out H3, §24.4).
import { randomUUID } from 'node:crypto';
import {
  b3err, b3fail, b3ok, mintTraceCorrelationId, nowIsoUtc,
  type B3Result, type CapabilityOwner, type EventCursor, type TraceCorrelationId,
} from '@novakai/foundation/contract';
import type { RunEvent, RunEventPage } from '../contract/runs-api.js';

export interface RunEventLog {
  append(
    kind: string, payload: Readonly<Record<string, unknown>>, traceId?: TraceCorrelationId,
    sourceOwner?: CapabilityOwner,
  ): RunEvent;
  read(after: string | undefined, limit: number): B3Result<RunEventPage>;
  subscribe(after: string | undefined): AsyncIterable<B3Result<RunEvent>>;
  /** Wake every open subscription and end it — the Runtime is going away. */
  close(): void;
}

/** Big enough that a controller reconnecting after a blip loses nothing. */
const DEFAULT_CAPACITY = 1_000;

const CURSOR = /^([0-9a-f]{12})\.(\d+)$/;

/**
 * A cursor names the log that minted it and the last event its holder saw.
 * Both halves matter: a sequence alone would let a cursor from a dead process
 * point confidently at somebody else's event 7.
 */
const cursorOf = (logId: string, sequence: number): EventCursor =>
  `${logId}.${String(sequence)}` as EventCursor;

const sequenceOf = (event: RunEvent): number => Number(event.cursor.split('.')[1] ?? 0);

/** §11 names this detail field `gap`, which is shorter than the house minimum. */
const GAP_FIELD = 'gap';
const gapDetail = (because: string): Record<string, string> => ({ [GAP_FIELD]: because });

export function createRunEventLog(capacity = DEFAULT_CAPACITY): RunEventLog {
  const logId = randomUUID().replace(/-/gu, '').slice(0, 12);
  const held: RunEvent[] = [];
  const waiting = new Set<(event: RunEvent | null) => void>();
  let newest = 0;
  let oldest = 1;
  let open = true;

  const expired = (because: string): ReturnType<typeof b3err> => b3err('CursorExpired',
    `the stream cannot resume from that cursor: ${because}`,
    { newestCursor: cursorOf(logId, newest), ...gapDetail(because) }, false);

  /** Where a cursor points, or why it cannot be honoured. */
  function positionOf(after: string | undefined): B3Result<number> {
    if (after === undefined) return b3ok(oldest - 1);
    const parsed = CURSOR.exec(after);
    if (parsed === null) {
      return b3fail(b3err('ValidationFailed', 'that is not an event cursor',
        { issues: [{ path: 'after', message: `not an EventCursor: ${after}` }] }, false));
    }
    if (parsed[1] !== logId) return b3fail(expired('the runtime that minted it has restarted'));
    const sequence = Number(parsed[2]);
    if (sequence > newest) return b3fail(expired('that cursor is ahead of this stream'));
    if (sequence < oldest - 1) return b3fail(expired('those events have been evicted'));
    return b3ok(sequence);
  }

  function append(
    kind: string, payload: Readonly<Record<string, unknown>>, traceId?: TraceCorrelationId,
    sourceOwner: CapabilityOwner = 'agent-runtime',
  ): RunEvent {
    newest += 1;
    const committedAt = nowIsoUtc();
    const event: RunEvent = {
      eventId: `event_${logId}_${String(newest)}`,
      kind,
      schemaVersion: 1,
      occurredAt: committedAt,
      committedAt,
      // §15: every event names the capability that OWNS the fact, not the
      // process that happened to append it. B3c's messaging/transcript facts
      // ride this one stream so a consumer keeps ONE cursor (§24.4), and
      // saying they came from agent-runtime would be a lie about ownership.
      sourceOwner,
      // The command's trace when the emitter had one to hand over; otherwise
      // this event's own. A correlation handle either way — never a claim that
      // some particular command caused it.
      traceId: traceId ?? mintTraceCorrelationId(),
      cursor: cursorOf(logId, newest),
      payload,
    };
    held.push(event);
    if (held.length > capacity) {
      held.shift();
      oldest += 1;
    }
    for (const wake of waiting) wake(event);
    waiting.clear();
    return event;
  }

  function read(after: string | undefined, limit: number): B3Result<RunEventPage> {
    const from = positionOf(after);
    if (!from.ok) return from;
    const events = held.filter((event) => sequenceOf(event) > from.value).slice(0, limit);
    const last = events[events.length - 1];
    return b3ok({ events, nextCursor: last?.cursor ?? cursorOf(logId, from.value) });
  }

  async function* subscribe(after: string | undefined): AsyncIterable<B3Result<RunEvent>> {
    const from = positionOf(after);
    if (!from.ok) {
      yield from;
      return;
    }
    let seen = from.value;
    while (open) {
      const backlog = held.filter((event) => sequenceOf(event) > seen);
      for (const event of backlog) {
        seen = sequenceOf(event);
        yield b3ok(event);
      }
      if (backlog.length > 0) continue;
      const next = await new Promise<RunEvent | null>((resolve) => { waiting.add(resolve); });
      if (next === null) return;
    }
  }

  return {
    append,
    read,
    subscribe,
    close() {
      open = false;
      for (const wake of waiting) wake(null);
      waiting.clear();
    },
  };
}
