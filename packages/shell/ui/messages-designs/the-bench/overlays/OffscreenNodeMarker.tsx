import { useEffect } from 'react';
import { useCanvasRuntime } from '../../../canvas/canvas-runtime-context';
import type { BenchOffscreenCandidate } from '../model/bench-model';
import './OffscreenNodeMarker.css';

/** Explicit locate affordance for newly opened content outside the visible canvas. */
export function OffscreenNodeMarker({
  candidates,
  onAcknowledge,
  onLocate,
}: {
  candidates: readonly BenchOffscreenCandidate[];
  onAcknowledge(nodeIds: readonly string[]): void;
  onLocate(nodeId: string): void;
}) {
  const runtime = useCanvasRuntime();
  const visibleIds = candidates
    .filter((candidate) => runtime.getNodeScreenBounds(candidate.nodeId) !== null)
    .map((candidate) => candidate.nodeId);
  const visibleKey = visibleIds.join('|');
  const offscreen = candidates.filter((candidate) => !visibleIds.includes(candidate.nodeId));
  const latest = offscreen.reduce<BenchOffscreenCandidate | null>((current, candidate) => (
    !current || candidate.openedSequence > current.openedSequence ? candidate : current
  ), null);

  useEffect(() => {
    if (visibleKey) onAcknowledge(visibleKey.split('|'));
  }, [onAcknowledge, visibleKey]);

  if (!latest) return null;
  return (
    <button
      type="button"
      className="bench-offscreen-marker"
      onClick={() => onLocate(latest.nodeId)}
      aria-label={`Locate ${offscreen.length} new offscreen ${offscreen.length === 1 ? 'item' : 'items'}`}
    >
      → {offscreen.length} new
    </button>
  );
}
