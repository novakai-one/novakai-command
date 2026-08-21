import { NodeResizeControl } from '@xyflow/react';

/**
 * One bottom-right resize control shared by every resizable Bench node. Only
 * the bottom-right corner is offered so a resize never moves the node. The
 * settled size flows through `onSettled` (the controller persists it and
 * re-projects in the same beat, so nothing snaps back).
 */
export function NodeResizeHandle({ nodeId, minWidth, minHeight, onSettled }: {
  nodeId: string;
  minWidth: number;
  minHeight: number;
  onSettled: (nodeId: string, size: { width: number; height: number }) => void;
}) {
  return (
    <NodeResizeControl
      position="bottom-right"
      minWidth={minWidth}
      minHeight={minHeight}
      className="bench-resize-control"
      onResizeEnd={(_, params) => {
        onSettled(nodeId, { width: params.width, height: params.height });
      }}
    >
      <span className="bench-resize-handle" aria-hidden="true" />
    </NodeResizeControl>
  );
}
