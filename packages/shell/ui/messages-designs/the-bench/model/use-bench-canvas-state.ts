import { useCallback, useRef, useState, type Dispatch, type MutableRefObject } from 'react';
import type {
  CanvasNodePlacement,
  CanvasPlacementChange,
  WorldPoint,
} from '../../../canvas/WorldCanvas';
import type { WorldViewport } from '../../../canvas/world-camera';
import { resolveBenchZoomTier } from './bench-interaction';
import { firstFreePoint } from './bench-layout';
import type { BenchAction } from './bench-model';

function placementSignature(placements: readonly CanvasNodePlacement[]): string {
  return placements
    .map((placement) => `${placement.id}:${placement.position.x}:${placement.position.y}:${placement.parentId ?? ''}`)
    .sort()
    .join('|');
}

/** Owns the latest neutral placement snapshot without importing canvas internals. */
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

/** Owns the Bench viewport reference and maps zoom to the semantic tier. */
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

/** Places new Bench objects inside the current viewport without overlapping remembered nodes. */
export function useBenchFirstFreePoint(
  placements: readonly CanvasNodePlacement[] | null,
  viewportRef: MutableRefObject<WorldViewport>,
): (requested?: WorldPoint) => WorldPoint {
  return useCallback((requested?: WorldPoint): WorldPoint => {
    const viewport = viewportRef.current;
    const canvasWidth = typeof window === 'undefined' ? 1200 : Math.max(640, window.innerWidth - 324);
    const canvasHeight = typeof window === 'undefined' ? 760 : Math.max(480, window.innerHeight - 213);
    const point = requested ?? {
      x: (canvasWidth * 0.55 - viewport.x) / viewport.zoom,
      y: (canvasHeight * 0.42 - viewport.y) / viewport.zoom,
    };
    const visibleBounds = requested ? undefined : {
      minX: (-viewport.x / viewport.zoom) + 24,
      maxX: ((canvasWidth - viewport.x) / viewport.zoom) - 344,
      minY: (-viewport.y / viewport.zoom) + 24,
      maxY: ((canvasHeight - viewport.y) / viewport.zoom) - 168,
    };
    return firstFreePoint(
      point,
      (placements ?? []).map((placement) => placement.position),
      visibleBounds,
    );
  }, [placements, viewportRef]);
}
