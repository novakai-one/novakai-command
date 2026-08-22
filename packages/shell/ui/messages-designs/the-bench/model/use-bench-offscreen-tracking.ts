import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CanvasPlacementChange } from '../../../canvas/WorldCanvas';
import type { BenchOffscreenCandidate } from './bench-model';
import type { BenchCanvasProjection } from './bench-projection';

type EligibleNode = {
  readonly kind: BenchOffscreenCandidate['kind'];
  readonly isOpen: boolean;
};

function eligibleNodes(projection: BenchCanvasProjection): Map<string, EligibleNode> {
  const eligible = new Map<string, EligibleNode>();
  for (const node of projection.nodes) {
    if (node.data.kind === 'conversation') {
      eligible.set(node.id, { kind: 'conversation', isOpen: node.data.isOpen });
    } else if (node.data.kind === 'message-inspector') {
      eligible.set(node.id, { kind: 'message-inspector', isOpen: true });
    } else if (node.data.kind === 'related-object') {
      eligible.set(node.id, { kind: 'related-object', isOpen: true });
    }
  }
  return eligible;
}

/** Tracks only newly opened offscreen content and exposes acknowledgement. */
export function useBenchOffscreenTracking(
  projection: BenchCanvasProjection,
  placementCause: CanvasPlacementChange['cause'] | null,
): {
  readonly offscreenCandidates: readonly BenchOffscreenCandidate[];
  readonly acknowledgeOffscreenNodes: (nodeIds: readonly string[]) => void;
} {
  const [offscreenCandidates, setOffscreenCandidates] = useState<readonly BenchOffscreenCandidate[]>([]);
  const sequenceRef = useRef(0);
  const readyRef = useRef(false);
  const previousEligibleNodesRef = useRef(new Map<string, EligibleNode>());

  useLayoutEffect(() => {
    const current = eligibleNodes(projection);
    if (!readyRef.current) {
      if (placementCause !== 'restore') return;
      previousEligibleNodesRef.current = current;
      readyRef.current = true;
      return;
    }

    const previous = previousEligibleNodesRef.current;
    const opened: BenchOffscreenCandidate[] = [];
    for (const [nodeId, node] of current) {
      const prior = previous.get(nodeId);
      const newlyOpened = !prior || (node.kind === 'conversation' && node.isOpen && !prior.isOpen);
      if (!newlyOpened) continue;
      sequenceRef.current += 1;
      opened.push({ nodeId, kind: node.kind, openedSequence: sequenceRef.current });
    }
    previousEligibleNodesRef.current = current;
    setOffscreenCandidates((candidates) => {
      const next = candidates
        .filter((candidate) => current.has(candidate.nodeId))
        .filter((candidate) => !opened.some((item) => item.nodeId === candidate.nodeId));
      return opened.length > 0 || next.length !== candidates.length ? [...next, ...opened] : candidates;
    });
  }, [placementCause, projection]);

  const acknowledgeOffscreenNodes = useCallback((nodeIds: readonly string[]) => {
    if (nodeIds.length === 0) return;
    const acknowledged = new Set(nodeIds);
    setOffscreenCandidates((candidates) => candidates.filter((candidate) => (
      !acknowledged.has(candidate.nodeId)
    )));
  }, []);

  return { offscreenCandidates, acknowledgeOffscreenNodes };
}
