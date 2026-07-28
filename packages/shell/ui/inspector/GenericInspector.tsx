// shell/ui/inspector/GenericInspector.tsx — the fallback inspector (ruling 10):
// kinds without a registered screen get an envelope + payload view, never a
// blank pane. Kit-composed ONLY (red gate 3 — tools/lint-kit.mjs enforces).
import React from 'react';
import type { InspectorScreenProps } from './registry.js';
import { DescriptionList, Heading, Pre, Stack } from '../kit/index.js';

export function GenericInspector(props: InspectorScreenProps) {
  const envelope = props.envelope ?? {};
  return (
    <Stack className="nv-inspector-view">
      <Heading level={3} className="nv-inspector-view__kind">{String(envelope.kind ?? 'object')}</Heading>
      <DescriptionList
        className="nv-inspector-view__envelope"
        items={Object.entries(envelope).map(([k, v]) => [
          k,
          typeof v === 'object' ? JSON.stringify(v) : String(v),
        ])}
      />
      {props.payload !== undefined && (
        <>
          <Heading level={4}>Payload</Heading>
          <Pre className="nv-inspector-view__payload">{JSON.stringify(props.payload, null, 2)}</Pre>
        </>
      )}
    </Stack>
  );
}
