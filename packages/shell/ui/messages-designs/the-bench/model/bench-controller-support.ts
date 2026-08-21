// bench-controller-support.ts — small self-contained hooks and identity
// helpers extracted from useBenchController so the orchestrator stays a
// readable composition (moved verbatim, not rewritten).
import { useCallback, useRef, useState, type Dispatch } from 'react';
import type { CanvasNodePlacement, CanvasPlacementChange } from '../../../canvas/WorldCanvas';
import type { WorldViewport } from '../../../canvas/world-camera';
import { resolveBenchZoomTier } from './bench-interaction';
import type { BenchAction } from './bench-model';

let benchIdentitySequence = 0;

/** Mints a unique, sortable client-side identity for Bench-owned nodes. */
export function nextBenchIdentity(prefix: 'draft' | 'frame' | 'placement'): string {
  benchIdentitySequence += 1;
  return `${prefix}:bench:${Date.now().toString(36)}:${benchIdentitySequence.toString(36)}`;
}

function placementSignature(placements: readonly CanvasNodePlacement[]): string {
  return placements
    .map((placement) => `${placement.id}:${placement.position.x}:${placement.position.y}:${placement.parentId ?? ''}`)
    .sort()
    .join('|');
}

/** Deduplicates placement-change echoes so identical snapshots re-render nothing. */
export function useBenchPlacements(): {
  readonly placementChange: CanvasPlacementChange | null;
  readonly rememberPlacementChange: (change: CanvasPlacementChange) => void;
} {
  const [placementChange, setPlacementChange] = useState<CanvasPlacementChange | null>(null);
  const placementSignatureRef = useRef<string | null>(null);
  const rememberPlacementChange = useCallback((change: CanvasPlacementChange) => {
    const signature = `${change.cause}:${change.movedNodeId ?? ''}:${placementSignature(change.placements)}`;
    if (signature === placementSignatureRef.current) return;
    placementSignatureRef.current = signature;
    setPlacementChange({
      ...change,
      placements: change.placements.map((placement) => ({
        ...placement,
        position: { ...placement.position },
      })),
    });
  }, []);

  return { placementChange, rememberPlacementChange };
}

/** Tracks the live viewport and folds zoom into the semantic zoom tier. */
export function useBenchViewportPolicy(dispatch: Dispatch<BenchAction>) {
  const viewportRef = useRef<WorldViewport>({ x: 0, y: 0, zoom: 0.82 });
  const onViewportChange = useCallback((viewport: WorldViewport) => {
    viewportRef.current = { ...viewport };
  }, []);
  const onZoomChange = useCallback((zoom: number) => {
    dispatch({ type: 'set-zoom-tier', tier: resolveBenchZoomTier(zoom) });
  }, [dispatch]);
  return { viewportRef, onViewportChange, onZoomChange };
}
