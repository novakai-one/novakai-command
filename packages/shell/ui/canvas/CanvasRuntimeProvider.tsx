import type { ReactNode } from 'react';
import type { CanvasRuntime } from './canvas-runtime';
import { CanvasRuntimeContext } from './canvas-runtime-context';

/** Makes one WorldCanvas runtime available to its design-owned overlays and controls. */
export function CanvasRuntimeProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: CanvasRuntime;
}) {
  return (
    <CanvasRuntimeContext.Provider value={runtime}>
      {children}
    </CanvasRuntimeContext.Provider>
  );
}
