import { findAgentDeliveryMarkerInLine } from './delivery-marker-codec.js';
import { mintPendingDeliveryId } from './mint.js';
import type { DeliveryReconcilerStore } from './delivery-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { TranscriptEvent } from '../../contract/ports/transcript-store.js';
import type { EventCursor } from '../../contract/types.js';

/** Events are scanned a page at a time so one pass never holds the whole stream in memory. */
const PAGE_SIZE = 256;

/** Ids of the transcript lines one event page points at. */
const lineIds = (events: readonly TranscriptEvent[]): ReadonlySet<string> =>
  new Set(events.flatMap((event) =>
    event.kind === 'transcript-line.appended' && event.transcriptLineId !== undefined
      ? [event.transcriptLineId] : []));

/** The lines one event page references, keyed by id so each event resolves in one lookup. */
async function linesById(
  store: DeliveryReconcilerStore,
  events: readonly TranscriptEvent[],
): Promise<ReadonlyMap<string, TranscriptLine>> {
  const wanted = lineIds(events);
  if (wanted.size === 0) return new Map();
  const lines = (await store.listTranscriptLines()).filter((line) => wanted.has(line.id));
  return new Map(lines.map((line) => [line.id, line]));
}

/** A queued delivery for one tool-result line carrying a marker, or undefined for any other line. */
function pendingFor(line: TranscriptLine | undefined): PendingDelivery | undefined {
  if (line?.role !== 'tool_result') return undefined;
  const marker = findAgentDeliveryMarkerInLine(line);
  if (marker === undefined) return undefined;
  return {
    id: mintPendingDeliveryId(line.id, marker.recipientAgentId),
    kind: 'pending-delivery',
    schemaVersion: 1,
    createdAt: line.createdAt,
    updatedAt: line.createdAt,
    transcriptLineId: line.id,
    recipientAgentId: marker.recipientAgentId,
    state: 'queued',
  };
}

/**
 * Queues the delivery one event implies, if any. The store's accept is
 * idempotent on the delivery id, so a duplicate reports itself and is not
 * counted as added.
 */
async function acceptForEvent(
  store: DeliveryReconcilerStore,
  event: TranscriptEvent,
  lines: ReadonlyMap<string, TranscriptLine>,
): Promise<number> {
  const delivery = pendingFor(event.transcriptLineId === undefined
    ? undefined : lines.get(event.transcriptLineId));
  if (delivery === undefined) return 0;
  const accepted = await store.acceptPendingDelivery({ delivery });
  return accepted.duplicate ? 0 : 1;
}

/** Queues every delivery one event page implies; returns how many were newly added. */
async function acceptPage(
  store: DeliveryReconcilerStore,
  events: readonly TranscriptEvent[],
): Promise<number> {
  const lines = await linesById(store, events);
  let added = 0;
  for (const event of events) {
    added += await acceptForEvent(store, event, lines);
  }
  return added;
}

/**
 * Watches the transcript event stream and queues one PendingDelivery for each
 * tool-result line that carries a valid delivery marker. Each pass is
 * incremental thanks to the cursor, so a restart resumes where the last pass
 * stopped instead of re-queueing old work.
 */
export class AddressedDeliveryReconciler {
  private cursor: EventCursor | undefined;

  /**
   * Scans every transcript event since the previous pass and queues a
   * delivery for each newly seen marker; returns how many were added.
   */
  async reconcile(store: DeliveryReconcilerStore): Promise<number> {
    let added = 0;
    let events = await store.scanTranscriptEvents(this.cursor, PAGE_SIZE);
    while (events.length > 0) {
      added += await acceptPage(store, events);
      this.cursor = events.at(-1)?.cursor;
      if (events.length < PAGE_SIZE) return added;
      events = await store.scanTranscriptEvents(this.cursor, PAGE_SIZE);
    }
    return added;
  }
}
