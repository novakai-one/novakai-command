import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { BenchCanvasEdge } from '../model/bench-projection';
import './InspectionWire.css';

/** Restrained amber bezier used only while an inspection trail exists. */
export function InspectionWire({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<BenchCanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.42,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className="bench-inspection-wire"
        data-emphasized={data?.emphasized ?? false}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <span
            className="bench-inspection-wire__label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
