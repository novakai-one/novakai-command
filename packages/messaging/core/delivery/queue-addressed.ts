import { createHash } from 'node:crypto';
import { findAgentDeliveryMarker } from './agent-delivery-marker.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { EventCursor, PendingDeliveryId } from '../../contract/types.js';
import type { TranscriptEvent } from '../../contract/ports/transcript-store.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';

const deliveryId = (lineId: string, recipientAgentId: string): PendingDeliveryId =>
  `pendingDelivery_${createHash('sha256')
    .update(`${lineId}:${recipientAgentId}`)
    .digest('hex')}` as PendingDeliveryId;

const lineIds = (events: readonly TranscriptEvent[]): ReadonlySet<string> =>
  new Set(events.flatMap((event) =>
    event.kind === 'transcript-line.appended' && event.transcriptLineId !== undefined
      ? [event.transcriptLineId] : []));

async function linesById(
  store: TranscriptStore,
  events: readonly TranscriptEvent[],
): Promise<ReadonlyMap<string, TranscriptLine>> {
  const wanted = lineIds(events);
  if (wanted.size === 0) return new Map();
  const lines = (await store.listTranscriptLines()).filter((line) => wanted.has(line.id));
  return new Map(lines.map((line) => [line.id, line]));
}

function pendingFor(line: TranscriptLine | undefined): PendingDelivery | undefined {
  if (line?.role !== 'tool_result') return undefined;
  const marker = findAgentDeliveryMarker(`${line.text}\n${line.raw}`);
  if (marker === undefined) return undefined;
  return {
    id: deliveryId(line.id, marker.recipientAgentId),
    kind: 'pending-delivery',
    schemaVersion: 1,
    createdAt: line.createdAt,
    updatedAt: line.createdAt,
    transcriptLineId: line.id,
    recipientAgentId: marker.recipientAgentId,
    state: 'queued',
  };
}

async function acceptPage(
  store: TranscriptStore,
  events: readonly TranscriptEvent[],
): Promise<number> {
  const lines = await linesById(store, events);
  let added = 0;
  for (const event of events) {
    const delivery = pendingFor(event.transcriptLineId === undefined
      ? undefined : lines.get(event.transcriptLineId));
    if (delivery === undefined) continue;
    const accepted = await store.acceptPendingDelivery({ delivery });
    if (accepted === delivery) added += 1;
  }
  return added;
}

/** Incrementally projects authenticated CLI result markers into durable work. */
export class AddressedDeliveryReconciler {
  private cursor: EventCursor | undefined;

  async reconcile(store: TranscriptStore): Promise<number> {
    let added = 0;
    while (true) {
      const events = await store.scanTranscriptEvents(this.cursor, 256);
      if (events.length === 0) return added;
      added += await acceptPage(store, events);
      this.cursor = events.at(-1)!.cursor;
      if (events.length < 256) return added;
    }
  }
}
