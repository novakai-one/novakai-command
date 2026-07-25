// Rail-width resize handlers (extracted from ../index.tsx for the ratchet).
// Drag a column edge: pointer capture keeps the drag alive off-handle; the
// width lands on pointerup. Arrow keys on the focused handle nudge ±16px.
import type React from 'react';
import { clampRailWidth, saveRailWidths, type RailWidths } from '../model.js';

export interface ResizeDeps {
  rootRef: { current: HTMLElement | null };
  widthsRef: { current: RailWidths };
  setWidths: (updater: (current: RailWidths) => RailWidths) => void;
  setResizing: (resizing: boolean) => void;
}

/** The drag lifecycle for one column edge (extracted for the 20-line rule). */
function dragHandlers(deps: ResizeDeps, kind: keyof RailWidths, rect: DOMRect, handle: HTMLElement): void {
  const move = (event: PointerEvent) => {
    const pixels = kind === 'rail' ? event.clientX - rect.left : rect.right - event.clientX;
    deps.setWidths((current) => ({ ...current, [kind]: clampRailWidth(kind, pixels) }));
  };
  const release = () => {
    handle.removeEventListener('pointermove', move);
    deps.setResizing(false);
    saveRailWidths(deps.widthsRef.current);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', release, { once: true });
}

export function beginResize(deps: ResizeDeps, kind: keyof RailWidths) {
  return (down: React.PointerEvent<HTMLElement>) => {
    const rect = deps.rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    down.preventDefault();
    const handle = down.currentTarget;
    handle.setPointerCapture(down.pointerId);
    deps.setResizing(true);
    dragHandlers(deps, kind, rect, handle);
  };
}

export function nudgeWidth(deps: ResizeDeps, kind: keyof RailWidths) {
  return (press: React.KeyboardEvent<HTMLElement>) => {
    if (press.key !== 'ArrowLeft' && press.key !== 'ArrowRight') return;
    press.preventDefault();
    const delta = (press.key === 'ArrowRight' ? 16 : -16) * (kind === 'rail' ? 1 : -1);
    const next = { ...deps.widthsRef.current, [kind]: clampRailWidth(kind, deps.widthsRef.current[kind] + delta) };
    deps.setWidths(() => next);
    saveRailWidths(next);
  };
}
