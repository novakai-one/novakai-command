import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { BenchMessageInspectorCanvasNode } from '../model/bench-projection';
import { ObjectRelationRows } from './ObjectNodeBody';
import './InspectionNodeShell.css';
import './MessageInspectorNode.css';

/** Thin first trail node listing the exact message's typed relationships. */
export function MessageInspectorNode({ data, selected }: NodeProps<BenchMessageInspectorCanvasNode>) {
  return (
    <aside className="bench-scribe-selection bench-inspection-node-shell bench-inspector-node" data-selected={selected}>
      <Handle id="trail-target" className="bench-trail-handle" type="target" position={Position.Left} />
      <header className="bench-inspection-node-shell__header bench-inspector-node__header">
        <span className="bench-stack-compact">
          <small className="bench-detail-label">Message links</small>
          <strong>
            {data.message.relations.length} related {data.message.relations.length === 1 ? 'record' : 'records'}
          </strong>
        </span>
        <button
          type="button"
          className="bench-icon-control bench-inspector-node__close nodrag"
          onClick={() => data.actions.closeTrailStep(data.trail.id, data.step.id)}
          aria-label="Close message inspection"
        >
          ×
        </button>
      </header>
      <p className="bench-inspector-node__excerpt">{data.message.body}</p>
      <ObjectRelationRows
        relations={data.message.relations}
        onExpand={(relation) => data.actions.expandRelation(
          data.trail.id,
          data.step.id,
          relation.relation,
          relation.record.id,
        )}
      />
    </aside>
  );
}
