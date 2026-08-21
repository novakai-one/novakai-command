import { Handle, Position } from '@xyflow/react';
import type { BenchMessage, BenchNodeActions } from '../model/bench-model';
import './MessageRecord.css';

function readableTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-AU', {
    hour: 'numeric',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';
}

/** One message whose full surface opens its relationship inspector. */
export function MessageRecord({
  threadId,
  message,
  startsGroup,
  actions,
}: {
  threadId: string;
  message: BenchMessage;
  startsGroup: boolean;
  actions: BenchNodeActions;
}) {
  const senderName = message.isMine ? 'Chris' : message.senderName;
  const timestamp = readableTime(message.createdAt);

  return (
    <article
      className="bench-message"
      data-mine={message.isMine}
      data-group-start={startsGroup}
    >
      <button
        type="button"
        className="bench-message__trigger nodrag"
        onClick={() => actions.inspectMessage(threadId, message.record.id)}
        aria-label={`Inspect message from ${senderName}, ${timestamp}: ${message.body}`}
      >
        <span className="bench-message__avatar" aria-hidden="true" title={senderName}>
          {initialsFor(senderName)}
        </span>
        <span className="bench-message__content">
          {startsGroup && (
            <span className="bench-message__meta">
              <time dateTime={message.createdAt}>{timestamp}</time>
            </span>
          )}
          <span className="bench-message__body">{message.body}</span>
          {message.failed && (
            <span className="bench-message__failed" role="alert">
              Not delivered — {message.failed}
            </span>
          )}
        </span>
      </button>

      <Handle
        id={`message:${message.record.id}:inspect`}
        className="bench-message__source"
        type="source"
        position={Position.Right}
      />
    </article>
  );
}
