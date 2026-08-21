import { Handle, Position, type NodeProps } from '@xyflow/react';
import { RELATION_LABEL } from '../../contract';
import type { BenchRelatedObjectCanvasNode } from '../model/bench-projection';
import { ObjectNodeBody } from './ObjectNodeBody';
import './InspectionNodeShell.css';
import './RelatedObjectNode.css';

/** One related object placed to the right of its parent trail step. */
export function RelatedObjectNode({ data, selected }: NodeProps<BenchRelatedObjectCanvasNode>) {
  return (
    <aside
      className="bench-scribe-selection bench-inspection-node-shell bench-related-node"
      data-record-kind={data.record.kind}
      data-selected={selected}
    >
      <Handle id="trail-target" className="bench-trail-handle" type="target" position={Position.Left} />
      <header className="bench-inspection-node-shell__header bench-related-node__header">
        <span className="bench-detail-label">{data.step.relation ? RELATION_LABEL[data.step.relation] ?? data.step.relation : 'Related'}</span>
        <button
          type="button"
          className="bench-icon-control nodrag"
          onClick={() => data.actions.closeTrailStep(data.trail.id, data.step.id)}
          aria-label={`Close ${data.record.title}`}
        >
          ×
        </button>
      </header>
      <div className="bench-related-node__body">
        <ObjectNodeBody
          record={data.record}
          relations={data.relations}
          decisionRequest={data.decisionRequest}
          onExpand={(relation) => data.actions.expandRelation(
            data.trail.id,
            data.step.id,
            relation.relation,
            relation.record.id,
          )}
          actions={data.actions}
        />
      </div>
    </aside>
  );
}
