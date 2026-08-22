import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorldPoint } from '../../../canvas/WorldCanvas';
import type { ObjectId } from '../../contract';
import type { BenchConversation } from './bench-model';
import { snapBenchPoint } from './bench-layout';

const POINTER_OFFSET = 16;
const UNDO_WINDOW_MS = 10_000;

/** Visible direct-manipulation state while a conversation follows the pointer. */
export type BenchPendingPlacement = {
  readonly threadId: ObjectId;
  readonly title: string;
  readonly initials: string;
  readonly point: WorldPoint;
};

/** One reversible Placement removal exposed without restoring Thread history. */
export type BenchRemovalUndo = {
  readonly threadId: ObjectId;
  readonly title: string;
};

export type RemovedBenchPlacement = BenchRemovalUndo & {
  readonly point: WorldPoint;
  readonly parentId?: string;
  readonly frameId?: string;
};

function dropPoint(pointer: WorldPoint): WorldPoint {
  return snapBenchPoint({
    x: pointer.x + POINTER_OFFSET,
    y: pointer.y + POINTER_OFFSET,
  });
}

/** Owns cancellable pointer placement and the short-lived inverse of a removal. */
export function useBenchPlacementInteraction(
  catalog: readonly BenchConversation[],
  initialPoint: () => WorldPoint,
) {
  const [pendingPlacement, setPendingPlacement] = useState<BenchPendingPlacement | null>(null);
  const [removedPlacement, setRemovedPlacement] = useState<RemovedBenchPlacement | null>(null);
  const pendingRef = useRef(pendingPlacement);
  const removedRef = useRef(removedPlacement);
  pendingRef.current = pendingPlacement;
  removedRef.current = removedPlacement;

  useEffect(() => {
    if (!removedPlacement) return;
    const timeout = window.setTimeout(() => setRemovedPlacement(null), UNDO_WINDOW_MS);
    return () => window.clearTimeout(timeout);
  }, [removedPlacement]);

  const beginPlacement = useCallback((threadId: ObjectId) => {
    const conversation = catalog.find((candidate) => candidate.thread.id === threadId);
    if (!conversation) return;
    setPendingPlacement({
      threadId,
      title: conversation.thread.title,
      initials: conversation.primaryParticipant?.initials ?? '—',
      point: initialPoint(),
    });
  }, [catalog, initialPoint]);

  const movePlacement = useCallback((pointer: WorldPoint) => {
    const pending = pendingRef.current;
    if (!pending) return;
    setPendingPlacement({ ...pending, point: dropPoint(pointer) });
  }, []);

  const takePlacement = useCallback((pointer: WorldPoint): BenchPendingPlacement | null => {
    const pending = pendingRef.current;
    if (!pending) return null;
    const committed = { ...pending, point: dropPoint(pointer) };
    pendingRef.current = null;
    setPendingPlacement(null);
    return committed;
  }, []);

  const cancelPlacement = useCallback(() => {
    pendingRef.current = null;
    setPendingPlacement(null);
  }, []);

  const offerRemovalUndo = useCallback((removed: RemovedBenchPlacement) => {
    removedRef.current = removed;
    setRemovedPlacement(removed);
  }, []);

  const takeRemovalUndo = useCallback((): RemovedBenchPlacement | null => {
    const removed = removedRef.current;
    removedRef.current = null;
    setRemovedPlacement(null);
    return removed;
  }, []);

  const dismissRemovalUndo = useCallback(() => {
    removedRef.current = null;
    setRemovedPlacement(null);
  }, []);

  return {
    pendingPlacement,
    removalUndo: removedPlacement
      ? { threadId: removedPlacement.threadId, title: removedPlacement.title }
      : null,
    beginPlacement,
    movePlacement,
    takePlacement,
    cancelPlacement,
    offerRemovalUndo,
    takeRemovalUndo,
    dismissRemovalUndo,
  };
}
