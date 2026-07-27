// shell/ui/screens/messaging/ThreadView.tsx — SHL-006/007.
// Pending bubble + activity line drawn immediately (never blank — red gate 5);
// typing bubble + presence dot; liveness motion ONLY when focused (M-19).
import React, { useEffect, useRef } from 'react';
import type { ChatMessage, ConversationSummary, PresenceSnapshot } from '../../../contract/index.js';
import { PresenceDot, ScrollArea, TypingBubble, EmptyState } from '../../kit/index.js';

export function ThreadView(props: {
  conversation: ConversationSummary | null;
  messages: ChatMessage[];
  presence: PresenceSnapshot | null;
  focused: boolean;
  selfId: string;
  renderSegments?: { text: string; gapBefore: boolean }[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [props.messages.length, props.renderSegments?.length]);

  if (!props.conversation) {
    return (
      <div className="nv-thread">
        <EmptyState>Pick a chat on the left, or start a new one (⌘N).</EmptyState>
      </div>
    );
  }

  const live = props.focused;
  const agentTyping = props.presence?.state === 'active';
  const activity = props.presence?.activity;

  return (
    <div className="nv-thread">
      <header className="nv-thread__head">
        {props.presence && <PresenceDot state={props.presence.state} live={live} />}
        <span className="nv-thread__title">{props.conversation.title}</span>
        {activity && <span className="nv-thread__activity">{activity}</span>}
      </header>
      <ScrollArea ref={scrollRef} className="nv-thread__scroll">
        <div className="nv-thread__col">
          {props.messages.length === 0 && !agentTyping && (
            <EmptyState>No messages yet — say hello.</EmptyState>
          )}
          {props.messages.map((m) => (
            <div key={m.id} className={`nv-msg${m.senderId === props.selfId ? ' nv-msg--mine' : ''}`}>
              <div className="nv-msg__bubble" data-pending={m.pending ? 'true' : 'false'}>{m.text}</div>
              {m.failed
                ? <div className="nv-msg__error">{m.failed}</div>
                : <div className="nv-msg__meta">{m.pending ? 'Sending…' : new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>}
            </div>
          ))}
          {props.renderSegments?.map((s, i) => (
            <React.Fragment key={i}>
              {s.gapBefore && <div className="nv-gap" aria-label="some content was skipped">…</div>}
              {s.text && (
                <div className="nv-msg">
                  <div className="nv-msg__bubble">{s.text}</div>
                </div>
              )}
            </React.Fragment>
          ))}
          {agentTyping && <TypingBubble live={live} />}
        </div>
      </ScrollArea>
    </div>
  );
}
