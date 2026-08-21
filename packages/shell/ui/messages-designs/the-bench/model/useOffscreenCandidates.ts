// useOffscreenCandidates.ts — tracks nodes that opened outside the viewport so
// the marker overlay can offer a reveal (moved verbatim from useBenchController).
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
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

/** Watches the projection for newly opened nodes the person may not see yet. */
export function useOffscreenCandidates(
  projection: BenchCanvasProjection,
  placementChangeCause: string | undefined,
): {
  readonly offscreenCandidates: readonly BenchOffscreenCandidate[];
  readonly acknowledgeOffscreenNodes: (nodeIds: readonly string[]) => void;
} {
  const [offscreenCandidates, setOffscreenCandidates] = useState<readonly BenchOffscreenCandidate[]>([]);
  const offscreenSequenceRef = useRef(0);
  const offscreenReadyRef = useRef(false);
  const previousEligibleNodesRef = useRef(new Map<string, EligibleNode>());

  useLayoutEffect(() => {
    const current = eligibleNodes(projection);
    if (!offscreenReadyRef.current) {
      if (placementChangeCause !== 'restore') return;
      previousEligibleNodesRef.current = current;
      offscreenReadyRef.current = true;
      return;
    }

    const previous = previousEligibleNodesRef.current;
    const opened: BenchOffscreenCandidate[] = [];
    for (const [nodeId, node] of current) {
      const prior = previous.get(nodeId);
      const newlyOpened = !prior || (node.kind === 'conversation' && node.isOpen && !prior.isOpen);
      if (!newlyOpened) continue;
      offscreenSequenceRef.current += 1;
      opened.push({ nodeId, kind: node.kind, openedSequence: offscreenSequenceRef.current });
    }
    previousEligibleNodesRef.current = current;
    setOffscreenCandidates((candidates) => {
      const next = candidates
        .filter((candidate) => current.has(candidate.nodeId))
        .filter((candidate) => !opened.some((item) => item.nodeId === candidate.nodeId));
      return opened.length > 0 || next.length !== candidates.length ? [...next, ...opened] : candidates;
    });
  }, [placementChangeCause, projection]);

  const acknowledgeOffscreenNodes = useCallback((nodeIds: readonly string[]) => {
    if (nodeIds.length === 0) return;
    const acknowledged = new Set(nodeIds);
    setOffscreenCandidates((candidates) => candidates.filter((candidate) => (
      !acknowledged.has(candidate.nodeId)
    )));
  }, []);

  return { offscreenCandidates, acknowledgeOffscreenNodes };
}
