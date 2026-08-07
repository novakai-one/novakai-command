// shell/ui/inspector/MessageInspector.tsx — the message kind's inspector
// screen (DEC-S2-8 "inspect and act"): sender, time, text, send-time context,
// and ONE primary action — Reply. Kit-composed ONLY (red gate 3).
import React from 'react';
import type { ChatMessage } from '../../contract/index.js';
import type { InspectorScreenProps } from './registry.js';
import { Blockquote, Button, DescriptionList, Stack } from '../kit/index.js';

export function MessageInspector(props: InspectorScreenProps) {
  const message = props.payload as ChatMessage;
  const ctx = message.context;
  return (
    <Stack className="nv-inspector-view nv-msg-inspector">
      <DescriptionList
        className="nv-inspector-view__envelope"
        items={[
          ['From', message.senderId],
          ['Sent', new Date(message.createdAt).toLocaleString()],
          ['Context', ctx ? (ctx.ref === 'none' ? `${ctx.app} · nothing focused` : `${ctx.app} · ${ctx.ref.kind}/${ctx.ref.id}`) : '—'],
        ]}
      />
      <Blockquote className="nv-msg-inspector__text">{message.text}</Blockquote>
      <Button onClick={() => props.onAction?.('reply')}>Reply</Button>
    </Stack>
  );
}
