/**
 * core/eventBus — the journal-sourced durable event bus (emit-only-after-durable).
 *
 * Store-Seam §11.1 makes the journal THE authoritative event source: every
 * committed-fact state change (acceptance commits, delivery transitions,
 * policy writes) is journaled with a global sequence. This bus tails
 * `store.scanJournal` from a checkpointed position and emits the three
 * committed-fact contract events to listeners. Emission happens only after
 * the fact is durable BY CONSTRUCTION — the bus reads committed journal
 * entries; nothing publishes from a pre-commit path.
 *
 * Coverage and exclusions (frozen):
 *  - MessageCommitted / DeliveryUpdated / PolicyChanged: journaled, emitted.
 *  - TemplateWritten journal entries are skipped — templates have no public
 *    event (seams/store.ts JournalEntry note).
 *  - PresenceChanged NEVER crosses this bus: it is an observation (R11 — no
 *    sequence, not journaled, never replayed) and flows from the presence
 *    registry directly (core/subscriptions.ts). Committed-fact frames carry
 *    `sequence`; observation frames do not — the two are distinguishable by
 *    construction (subscribe.ts SubscriptionEventFrame).
 *
 * Position discipline: the bus checkpoints the last-emitted sequence in
 * memory and re-scans from it (gaps are legal, Store-Seam §3 — compare,
 * never count). Tailing starts at sequence 0: history emitted before any
 * subscription exists reaches nobody, and a subscriber's own replay (R1,
 * `since` cursor against the same journal) plus its sequence watermark
 * dedupe whatever the live tail overlaps — so starting at 0 is safe in both
 * modes, and a pump after a commit ALWAYS sees the new entry. A process
 * restart loses the in-memory position — and every live subscription with
 * it (Presences die with the process), so clients re-subscribe with their
 * last cursor and replay from the journal. The journal, not the bus
 * position, is what survives.
 *
 * Driving: standalone mode tails on a short interval (composition config);
 * embedded/tests call `pump()` explicitly for determinism. Either way the
 * event CONTENT always comes from scanJournal — a post-commit trigger can
 * only make the bus LOOK, never speak for the journal.
 *
 * Concurrency (L2): ALL tail cycles — interval and manual — pass through one
 * pump guard, so two cycles never run concurrently (concurrent tails would
 * emit the same journal slice twice). A pump requested while a cycle is in
 * flight sets a rerun flag: the in-flight cycle's last scan may predate a
 * fresh commit, so one more cycle runs before the guard releases — a commit
 * is never stranded behind an in-flight scan.
 *
 * Listener failure (L3): a throwing fact listener is a bug in the listener,
 * but it must not stall the bus (pre-fix: position froze and the same fact
 * was retried forever). The throw is surfaced via onError (the subscription
 * manager ends live subscriptions dependency-lost — clients re-subscribe
 * with their last cursor and replay the gap, R1's honest recovery), the
 * checkpoint still advances past the fact, and the bus keeps tailing.
 */

import { constants } from "../public/contract/index.js";
import { MessagingError } from "../public/contract/index.js";
import type { Sequence } from "../public/contract/index.js";
import type { MessagingStore } from "../seams/store.js";
import { projectJournalEntry } from "./journalProjection.js";
import type { CommittedFact } from "./journalProjection.js";
import { storeDependencyError } from "./storeErrors.js";

/**
 * Re-exported from the projection that produces it, so consumers keep the
 * import they have always used while the dependency runs one way only.
 */
export type { CommittedFact } from "./journalProjection.js";

export type EventBusFactListener = (fact: CommittedFact) => Promise<void>;
/** Journal/store failure mid-tail (R1: subscriptions end dependency-lost). */
export type EventBusErrorListener = (error: MessagingError) => void;

export interface EventBusOptions {
  /** When set, the bus tails on this interval (standalone mode). Absent = manual pump only. */
  pollIntervalMs?: number;
  /** Journal page size per scan (default constants.pageLimitMax). */
  pageSize?: number;
}

export interface EventBus {
  /** Begin tailing (interval if configured). Idempotent; starts from sequence 0. */
  start(): Promise<void>;
  stop(): void;
  /** One tail cycle NOW (post-commit trigger / test determinism). */
  pump(): Promise<void>;
  onFact(listener: EventBusFactListener): void;
  onError(listener: EventBusErrorListener): void;
  /** The checkpoint: sequence of the last journal entry emitted (0 at start). */
  readonly position: Sequence;
}

export function createEventBus(store: MessagingStore, options?: EventBusOptions): EventBus {
  const pageSize = options?.pageSize ?? constants.pageLimitMax;
  const factListeners: EventBusFactListener[] = [];
  const errorListeners: EventBusErrorListener[] = [];

  let position = 0 as Sequence;
  let started = false;
  let pumping = false;
  let rerunRequested = false;
  let interval: NodeJS.Timeout | undefined;

  function notifyError(error: MessagingError): void {
    for (const listener of errorListeners) listener(error);
  }

  async function tailOnce(): Promise<void> {
    for (;;) {
      const page = await store.scanJournal(position, pageSize);
      if (page.kind === "error") {
        // Position NOT advanced — the next cycle retries. Listeners (the
        // subscription manager) surface dependency-lost (R1).
        notifyError(storeDependencyError(page.error));
        return;
      }
      for (const entry of page.value) {
        // Entries with no v1 public event (TemplateWritten; the B3c
        // endpoint/inbox facts) advance the position and produce nothing.
        const fact = projectJournalEntry(entry);
        if (fact === null) {
          position = entry.sequence;
          continue;
        }
        for (const listener of factListeners) {
          try {
            await listener(fact);
          } catch (cause) {
            // L3: a throwing listener must not stall the bus. Surface the
            // failure (listeners end subscriptions dependency-lost — clients
            // re-subscribe and replay the gap) and keep going: the checkpoint
            // still advances, so the same fact is never retried forever.
            notifyError(
              new MessagingError("DependencyUnavailable", {
                message: `event-bus listener threw: ${cause instanceof Error ? cause.message : String(cause)}`,
                retryable: true,
                fields: { dependency: "store", retryable: true },
              }),
            );
          }
        }
        // The checkpoint advances only AFTER listeners have seen the fact.
        position = entry.sequence;
      }
      if (page.value.length < pageSize) return;
    }
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    // Tailing starts at sequence 0: pre-subscription emissions reach nobody,
    // and per-subscription replay + watermark dedupe handles every overlap.
    if (options?.pollIntervalMs !== undefined) {
      interval = setInterval(() => {
        // L2: the interval tail goes through the SAME pump guard as manual
        // pumps — concurrent tails would emit the same journal slice twice.
        void pump().catch(() => {
          // tailOnce handles store errors via notifyError; a throw here is
          // a listener bug — the bus outlives it.
        });
      }, options.pollIntervalMs);
      interval.unref?.();
    }
  }

  async function pump(): Promise<void> {
    if (!started) await start();
    if (pumping) {
      // L2: a cycle is in flight — but its last scan may predate the commit
      // this pump is meant to see, so "covered" is NOT guaranteed. Flag a
      // rerun; the in-flight pump runs one more cycle before releasing.
      rerunRequested = true;
      return;
    }
    pumping = true;
    try {
      do {
        rerunRequested = false;
        await tailOnce();
      } while (rerunRequested);
    } finally {
      pumping = false;
    }
  }

  return {
    get position(): Sequence {
      return position;
    },

    start,

    stop(): void {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
    },

    pump,

    onFact(listener: EventBusFactListener): void {
      factListeners.push(listener);
    },

    onError(listener: EventBusErrorListener): void {
      errorListeners.push(listener);
    },
  };
}
