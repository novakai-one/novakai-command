import { useEffect, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { BenchConversationFrameCanvasNode } from '../model/bench-projection';
import { NodeResizeHandle } from './NodeResizeHandle';
import './ConversationFrameNode.css';

/** A named semantic grouping whose canvas parent mechanics stay in WorldCanvas. */
export function ConversationFrameNode({ data, selected }: NodeProps<BenchConversationFrameCanvasNode>) {
  const [name, setName] = useState(data.frame.name);
  useEffect(() => setName(data.frame.name), [data.frame.name]);

  const commitName = () => {
    const next = name.trim() || 'Untitled frame';
    setName(next);
    data.actions.renameFrame(data.frame.id, next);
  };

  return (
    <section className="bench-scribe-selection bench-frame" data-selected={selected}>
      <NodeResizeHandle nodeId={data.frame.id} minWidth={420} minHeight={280} onSettled={data.actions.rememberNodeSize} />
      <header className="bench-frame__header">
        <span className="bench-eyebrow" aria-hidden="true">Frame</span>
        <input
          className="bench-panel-control nodrag"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          aria-label="Frame name"
        />
        <small className="bench-eyebrow">{data.frame.conversationIds.length} conversations</small>
        <button
          type="button"
          className="nodrag"
          onClick={() => data.actions.removeFrame(data.frame.id)}
          aria-label={`Remove frame ${data.frame.name}`}
        >
          ×
        </button>
      </header>
      <div className="bench-frame__field nodrag" aria-hidden="true" />
    </section>
  );
}
