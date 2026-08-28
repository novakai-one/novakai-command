import type {
  TranscriptEvent,
  TranscriptStore,
} from "../contract/ports/transcript-store.js";
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
): DurableTranscriptEventBus {
  const sinks = new Set<TranscriptEventSink>();
  let deliveredThrough: EventCursor | undefined;
  let pumpTail: Promise<unknown> = Promise.resolve();

  const pumpOnce = async (): Promise<number> => {
    let delivered = 0;
    for (;;) {
      const events = await store.scanTranscriptEvents(deliveredThrough, 256);
      if (events.length === 0) return delivered;
      for (const event of events) {
        for (const sink of sinks) await sink(event);
        deliveredThrough = event.cursor;
        delivered += 1;
      }
      if (events.length < 256) return delivered;
    }
  };

  return {
    subscribe(sink) {
      sinks.add(sink);
      return { close: () => { sinks.delete(sink); } };
    },
    pump() {
      const run = pumpTail.then(pumpOnce, pumpOnce);
      pumpTail = run.then(() => undefined, () => undefined);
      return run;
    },
    cursor: () => deliveredThrough,
  };
}
