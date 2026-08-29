import type {
  TranscriptEvent,
  TranscriptStore,
} from "../contract/ports/transcript-store.js";
import type { MessagingTraceSink } from "../contract/trace.js";
import type { EventCursor } from "../contract/types.js";

type TranscriptEventSink = (event: TranscriptEvent) => void | Promise<void>;

/**
 * In-process subscription to the store's committed transcript events. Sinks
 * receive events in commit order; `pump` drains the journal from the last
 * delivered cursor, so nothing is replayed and nothing is skipped.
 */
export interface DurableTranscriptEventBus {
  subscribe(sink: TranscriptEventSink): { close(): void };
  pump(): Promise<number>;
  cursor(): EventCursor | undefined;
}

/**
 * Journal-backed fan-out over the transcript store. The bus only moves
 * committed events to subscribers — it never creates or persists content, so
 * the store journal remains the single authority and a restarted bus resumes
 * from its cursor without loss. Pumps are chained so concurrent triggers
 * collapse into one ordered drain.
 */
export function createDurableTranscriptEventBus(
  store: TranscriptStore,
  trace?: MessagingTraceSink,
): DurableTranscriptEventBus {
  const sinks = new Set<TranscriptEventSink>();
  let deliveredThrough: EventCursor | undefined;
  let pumpTail: Promise<unknown> = Promise.resolve();

  const pumpOnce = async (): Promise<number> => {
    let delivered = 0;
    for (;;) {
      const batch = await pumpBatch();
      delivered += batch;
      if (batch < 256) return delivered;
    }
  };

  /** Drains one page of committed events; a short page means the journal is caught up. */
  const pumpBatch = async (): Promise<number> => {
    const events = await store.scanTranscriptEvents(deliveredThrough, 256);
    await deliverBatch(events);
    return events.length;
  };

  /** Delivers one batch to every sink in commit order, advancing the cursor per event. */
  const deliverBatch = async (events: readonly TranscriptEvent[]): Promise<void> => {
    for (const event of events) {
      for (const sink of sinks) await sink(event);
      deliveredThrough = event.cursor;
    }
  };

  const tracedPump = async (): Promise<number> => {
    const delivered = await pumpOnce();
    if (delivered > 0 && deliveredThrough !== undefined) {
      trace?.({
        stage: 'eventbus.drained',
        detail: `delivered ${delivered} events through ${deliveredThrough}`,
      });
    }
    return delivered;
  };

  return {
    subscribe(sink) {
      sinks.add(sink);
      return { close: () => { sinks.delete(sink); } };
    },
    pump() {
      const pumpRun = pumpTail.then(tracedPump, tracedPump);
      pumpTail = pumpRun.then(() => undefined, () => undefined);
      return pumpRun;
    },
    cursor: () => deliveredThrough,
  };
}
