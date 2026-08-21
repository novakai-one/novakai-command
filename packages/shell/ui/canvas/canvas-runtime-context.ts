import { createContext, useContext } from 'react';
import type { CanvasNodeScreenBounds, CanvasRuntime } from './canvas-runtime';

/** Internal React context shared by the provider and the public canvas hooks. */
export const CanvasRuntimeContext = createContext<CanvasRuntime | null>(null);

/** Returns the nearest WorldCanvas runtime without exposing React Flow. */
export function useCanvasRuntime(): CanvasRuntime {
  const runtime = useContext(CanvasRuntimeContext);

  if (!runtime) {
    throw new Error('useCanvasRuntime must be used inside WorldCanvas.');
  }

  return runtime;
}

/** Returns reactive screen bounds for a visible node, or null when no anchor exists. */
export function useCanvasNodeAnchor(nodeId: string | null): CanvasNodeScreenBounds | null {
  const runtime = useCanvasRuntime();
  return nodeId ? runtime.getNodeScreenBounds(nodeId) : null;
}
