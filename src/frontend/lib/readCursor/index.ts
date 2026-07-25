// ReadCursor store (C21). One MONOTONIC cursor per conversation lane: the
// createdAt of the newest envelope Chris actually saw in the foreground.
// Opening a lane never advances it by itself — the transcript reports genuine
// visibility (its live edge shown while the tab is visible). Cursors and
// scroll anchors persist to localStorage so a reload restores both exactly;
// unread is always DERIVED (feed past cursor), never its own store.
import { useEffect, useState } from 'react';
import {
  CHRIS,
  conversationIdsFor,
  type ConversationId,
  type TunnelEnvelope,
} from '../messagingV2/index.js';

const CURSOR_KEY = 'novakai-read-cursors-v1';
const ANCHOR_KEY = 'novakai-scroll-anchors-v1';
const LANE_KEY = 'novakai-selected-lane-v1';

type CursorMap = Record<ConversationId, string>;

function loadJson<T>(storageKey: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

let cursors: CursorMap = loadJson<CursorMap>(CURSOR_KEY, {});
const listeners = new Set<() => void>();

function persistCursors(): void {
  try { localStorage.setItem(CURSOR_KEY, JSON.stringify(cursors)); } catch { /* derived state */ }
}

export function cursorFor(id: ConversationId): string | null {
  return cursors[id] ?? null;
}

/** Advance is monotonic: a cursor never moves backwards, so partial reads and
 * out-of-order reports can only ever under-count what was seen. */
export function advanceCursor(id: ConversationId, seenCreatedAt: string): void {
  const current = cursors[id];
  if (current && current >= seenCreatedAt) return;
  cursors = { ...cursors, [id]: seenCreatedAt };
  persistCursors();
  listeners.forEach((notify) => notify());
}

/** Subscribable snapshot — rails re-derive unread when any cursor moves. */
export function useReadCursors(): CursorMap {
  const [snapshot, setSnapshot] = useState<CursorMap>(cursors);
  useEffect(() => {
    const notify = (): void => setSnapshot(cursors);
    listeners.add(notify);
    return () => { listeners.delete(notify); };
  }, []);
  return snapshot;
}

/** Envelopes in a lane past its cursor, not authored by Chris. */
export function unreadCountFor(
  feed: TunnelEnvelope[],
  id: ConversationId,
  cursorMap: CursorMap,
): number {
  const cursor = cursorMap[id];
  let count = 0;
  for (const envelope of feed) {
    if (envelope.from === CHRIS) continue;
    if (!conversationIdsFor(envelope).includes(id)) continue;
    if (!cursor || envelope.createdAt > cursor) count += 1;
  }
  return count;
}

/** The catch-up deep-link target: the oldest unseen envelope in a lane. */
export function firstUnreadId(messages: TunnelEnvelope[], cursor: string | null): string | null {
  for (const envelope of messages) {
    if (envelope.from === CHRIS) continue;
    if (!cursor || envelope.createdAt > cursor) return envelope.id;
  }
  return null;
}

/* ---- scroll anchors + active lane (reload restores the exact seat) ---- */

let anchors = loadJson<Record<ConversationId, number>>(ANCHOR_KEY, {});

export function anchorFor(id: ConversationId): number | null {
  return anchors[id] ?? null;
}

export function saveAnchor(id: ConversationId, scrollTop: number): void {
  anchors = { ...anchors, [id]: Math.round(scrollTop) };
  try { localStorage.setItem(ANCHOR_KEY, JSON.stringify(anchors)); } catch { /* derived state */ }
}

export function savedLane(): ConversationId | null {
  try {
    return localStorage.getItem(LANE_KEY);
  } catch {
    return null;
  }
}

export function saveLane(id: ConversationId): void {
  try { localStorage.setItem(LANE_KEY, id); } catch { /* derived state */ }
}
