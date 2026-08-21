import { useLayoutEffect, useRef } from 'react';
import type { BenchMessage, BenchNodeActions } from '../model/bench-model';
import { MessageRecord } from './MessageRecord';
import './MessageTranscript.css';

const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

function senderIdentity(message: BenchMessage): string {
  if (message.sender) return message.sender.id;
  const storedSenderId = message.record.fields.senderId;
  return typeof storedSenderId === 'string' ? storedSenderId : `unresolved:${message.record.id}`;
}

function startsMessageGroup(previous: BenchMessage | undefined, current: BenchMessage): boolean {
  if (!previous || senderIdentity(previous) !== senderIdentity(current)) return true;
  const previousTime = Date.parse(previous.createdAt);
  const currentTime = Date.parse(current.createdAt);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return true;
  const gap = currentTime - previousTime;
  return gap < 0 || gap > MESSAGE_GROUP_WINDOW_MS;
}

/** Scrollable transcript shared by the canvas thread and later Zen presentation. */
export function MessageTranscript({
  threadId,
  messages,
  composingAgentName,
  savedScrollTop,
  actions,
}: {
  threadId: string;
  messages: readonly BenchMessage[];
  composingAgentName: string | null;
  savedScrollTop: number;
  actions: BenchNodeActions;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = savedScrollTop;
  }, [savedScrollTop, threadId]);

  return (
    <div
      ref={transcriptRef}
      className="bench-transcript nodrag nowheel"
      onScroll={(event) => actions.rememberTranscriptScroll(threadId, event.currentTarget.scrollTop)}
    >
      {messages.length > 0 ? messages.map((message, index) => (
        <MessageRecord
          key={message.record.id}
          threadId={threadId}
          message={message}
          startsGroup={startsMessageGroup(messages[index - 1], message)}
          actions={actions}
        />
      )) : (
        <p className="bench-transcript__empty">Nothing has been said yet. Start with the thing that matters.</p>
      )}

      {composingAgentName && (
        <p className="bench-transcript__composing" role="status">
          <span aria-hidden="true"><i /><i /><i /></span>
          {composingAgentName} is composing
        </p>
      )}
    </div>
  );
}
