// shell/ui/screens/messaging/ThreadView.tsx — SHL-006/007.
// Pending bubble + activity line drawn immediately (never blank — red gate 5);
// typing bubble + presence dot; liveness motion ONLY when focused (M-19).
// Kit-composed ONLY (red gate 3 — tools/lint-kit.mjs enforces).
import React, { useEffect, useRef } from 'react';
import type { ChatMessage, ConversationSummary, PresenceSnapshot } from '../../../contract/index.js';
import { Button, PresenceDot, ScrollArea, Stack, Text, TypingBubble, EmptyState } from '../../kit/index.js';

export function ThreadView(props: {
  conversation: ConversationSummary | null;
  messages: ChatMessage[];
  presence: PresenceSnapshot | null;
  focused: boolean;
  selfId: string;
  renderSegments?: { text: string; gapBefore: boolean }[];
  onInspectMessage?(m: ChatMessage): void;
  onResendMessage?(m: ChatMessage): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [props.messages.length, props.renderSegments?.length]);

  if (!props.conversation) {
    return (
      <Stack className="nv-thread">
        <EmptyState>Pick a chat on the left, or start a new one (⌘N).</EmptyState>
      </Stack>
    );
  }

  const live = props.focused;
  const agentTyping = props.presence?.state === 'active';
  const activity = props.presence?.activity;

  return (
    <Stack className="nv-thread">
      <Stack horizontal className="nv-thread__head">
        {props.presence && <PresenceDot state={props.presence.state} live={live} />}
        <Text className="nv-thread__title">{props.conversation.title}</Text>
        {activity && <Text className="nv-thread__activity">{activity}</Text>}
      </Stack>
      <ScrollArea ref={scrollRef} className="nv-thread__scroll">
        <Stack className="nv-thread__col">
          {props.messages.length === 0 && !agentTyping && (
            <EmptyState>No messages yet — say hello.</EmptyState>
          )}
          {props.messages.map((m) => (
            <Stack key={m.id} className={`nv-msg${m.senderId === props.selfId ? ' nv-msg--mine' : ''}`}>
              <Stack
                className="nv-msg__bubble" data-pending={m.pending ? 'true' : 'false'}
                role={props.onInspectMessage ? 'button' : undefined}
                title={props.onInspectMessage ? 'Inspect message' : undefined}
                onClick={props.onInspectMessage ? () => props.onInspectMessage!(m) : undefined}
              >{m.text}</Stack>
              {m.failed
                ? (
                  <Stack horizontal className="nv-msg__failure">
                    <Text className="nv-msg__error">{m.failed}</Text>
                    {m.clientOpId && props.onResendMessage && (
                      <Button className="nv-msg__resend" onClick={() => props.onResendMessage!(m)}>
                        Resend
                      </Button>
                    )}
                  </Stack>
                )
                : <Text className="nv-msg__meta">{m.pending ? 'Sending…' : new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>}
            </Stack>
          ))}
          {props.renderSegments?.map((s, i) => (
            <React.Fragment key={i}>
              {s.gapBefore && <Stack className="nv-gap" aria-label="some content was skipped">…</Stack>}
              {s.text && (
                <Stack className="nv-msg">
                  <Stack className="nv-msg__bubble">{s.text}</Stack>
                </Stack>
              )}
            </React.Fragment>
          ))}
          {agentTyping && <TypingBubble live={live} />}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
