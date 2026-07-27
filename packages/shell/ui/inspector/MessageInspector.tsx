// shell/ui/inspector/MessageInspector.tsx — the message kind's inspector
// screen (DEC-S2-8 "inspect and act"): sender, time, text, send-time context,
// and ONE primary action — Reply.
import React from 'react';
import type { ChatMessage } from '../../contract/index.js';
import type { InspectorScreenProps } from './registry.js';
import { Button } from '../kit/index.js';

export function MessageInspector(props: InspectorScreenProps) {
  const message = props.payload as ChatMessage;
  const ctx = message.context;
  return (
    <div className="nv-inspector-view nv-msg-inspector">
      <dl className="nv-inspector-view__envelope">
        <dt>From</dt><dd>{message.senderId}</dd>
        <dt>Sent</dt><dd>{new Date(message.createdAt).toLocaleString()}</dd>
        <dt>Context</dt>
        <dd>{ctx ? (ctx.ref === 'none' ? `${ctx.app} · nothing focused` : `${ctx.app} · ${ctx.ref.kind}/${ctx.ref.id}`) : '—'}</dd>
      </dl>
      <blockquote className="nv-msg-inspector__text">{message.text}</blockquote>
      <Button onClick={() => props.onAction?.('reply')}>Reply</Button>
    </div>
  );
}
