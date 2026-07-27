// shell/ui/inspector/GenericInspector.tsx — the fallback inspector (ruling 10):
// kinds without a registered screen get an envelope + payload view, never a
// blank pane.
import React from 'react';
import type { InspectorScreenProps } from './registry.js';

export function GenericInspector(props: InspectorScreenProps) {
  const envelope = props.envelope ?? {};
  return (
    <div className="nv-inspector-view">
      <h3 className="nv-inspector-view__kind">{String(envelope.kind ?? 'object')}</h3>
      <dl className="nv-inspector-view__envelope">
        {Object.entries(envelope).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
          </React.Fragment>
        ))}
      </dl>
      {props.payload !== undefined && (
        <>
          <h4>Payload</h4>
          <pre className="nv-inspector-view__payload">{JSON.stringify(props.payload, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
