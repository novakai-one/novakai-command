import type { NodeProps } from '@xyflow/react';
import type { BenchDraftConversationCanvasNode } from '../model/bench-projection';
import './DraftConversationNode.css';

/** Spatial agent picker that becomes the returned thread without losing placement. */
export function DraftConversationNode({ data, selected }: NodeProps<BenchDraftConversationCanvasNode>) {
  return (
    <section className="bench-draft" data-selected={selected}>
      <header className="bench-draft__header">
        <span>
          <small className="bench-eyebrow">New conversation</small>
          <strong>Choose an agent</strong>
        </span>
        <button type="button" className="bench-panel-control nodrag" onClick={data.cancel} aria-label="Cancel new conversation">
          ×
        </button>
      </header>
      <div className="bench-draft__agents nodrag nowheel">
        {data.agents.length > 0 ? data.agents.map((agent) => (
          <button key={agent.id} type="button" className="bench-hover-wash nodrag" onClick={() => data.accept(agent)}>
            <span>{agent.title.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}</span>
            <strong>{agent.title}</strong>
            <small>{agent.id}</small>
          </button>
        )) : (
          <p>No live agents are available.</p>
        )}
      </div>
    </section>
  );
}
