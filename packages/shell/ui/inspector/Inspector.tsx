// shell/ui/inspector/Inspector.tsx — the inspector host. Resolves the kind's
// registered screen; kinds without one render the generic inspector (ruling
// 10). Actions dispatch through invokeAction → the owning capability.
import React from 'react';
import { invokeAction } from '../../contract/index.js';
import { inspectorScreenFor, type InspectorScreenProps } from './registry.js';
import { GenericInspector } from './GenericInspector.js';
import './inspector.css';

export function Inspector(props: InspectorScreenProps & { kind: string; refId?: string }) {
  const Screen = inspectorScreenFor(props.kind);
  const onAction = async (actionId: string) => {
    if (props.refId) await invokeAction({ kind: props.kind, id: props.refId }, actionId);
    props.onAction?.(actionId);
  };
  if (!Screen) {
    return <GenericInspector envelope={props.envelope} payload={props.payload} onAction={props.onAction} />;
  }
  return <Screen envelope={props.envelope} payload={props.payload} onAction={onAction} />;
}
