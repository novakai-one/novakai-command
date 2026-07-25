// MessageFeed — the storyboard's center column: day pills, message rows
// (avatar square, name + role, body, timestamp), reply context when a parent
// exists, "Agent working…" on the lane's live edge. Scroll seat + ReadCursor
// advance are PORTED from studio/chat/tunnel/transcript (that shared
// component can't change — C21 rules preserved exactly: open ≠ read, the
// cursor moves only on genuine visibility at the live edge).
import React, { useEffect, useRef, useState } from 'react';
import type { AgentInfo } from '../../../../lib/agentSocket/index.js';
import { anchorFor, saveAnchor } from '../../../../lib/readCursor/index.js';
import type { MentionTarget } from '../../../../lib/mentions/index.js';
import { MarkdownText } from '../../../../lib/markdown/index.js';
import { MentionText } from '../../../studio/chat/mention/index.js';
import type {
  Conversation,
  TunnelEnvelope,
} from '../../../../lib/messagingV2/index.js';
import {
  displayNameFor,
  formatClockTime,
  groupByDay,
  initialFor,
  isCollapsible,
  isOwnFreshSend,
  replyLabelFor,
  roleFor,
  rowDeliveryFor,
  snippetFor,
  userScrollActive,
  workingAgentFor,
} from '../model.js';
import { FOLD_STYLE, NEW_MESSAGE_STYLE, resolveStyle } from '../styles/index.js';
import './index.css';

const BOTTOM_SLACK_PX = 48;

/** The M7 glide: smooth-scroll the feed to its live edge (the newest row). */
function scrollToLiveEdge(body: HTMLDivElement): void {
  // eslint-disable-next-line id-length -- ScrollToOptions keys are fixed by the DOM API
  body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
}

export function messageRowId(envelopeId: string): string {
  return `msg-row-${envelopeId}`;
}

/** Long bodies collapse to a snippet; a row click (outside links/buttons)
 *  toggles the full text. Short bodies render full, no affordance. Both
 *  states stay mounted in a fold track that glides 0fr/1fr on the struct
 *  token (the house reveal pattern — see wt-reveal in the old renderers). */
function CollapsibleBody(props: {
  body: string;
  targets: MentionTarget[];
  expanded: boolean;
  onToggle(): void;
}) {
  const { body, targets, expanded, onToggle } = props;
  if (!isCollapsible(body)) {
    return (
      <div className="msg-row-text">
        <MarkdownText text={body} renderText={(plain) => <MentionText text={plain} targets={targets} />} />
      </div>
    );
  }
  return (
    <>
      <div className="msg-row-foldbox">
        <div
          className={resolveStyle(FOLD_STYLE.fold, !expanded && FOLD_STYLE.open)}
          aria-hidden={expanded}
        >
          <div className="msg-row-fold-clip">
            <div className="msg-row-text">
              <MentionText text={snippetFor(body)} targets={targets} />
            </div>
          </div>
        </div>
        <div
          className={resolveStyle(FOLD_STYLE.fold, expanded && FOLD_STYLE.open)}
          aria-hidden={!expanded}
        >
          <div className="msg-row-fold-clip">
            <div className="msg-row-text">
              <MarkdownText text={body} renderText={(plain) => <MentionText text={plain} targets={targets} />} />
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="msg-row-toggle"
        aria-expanded={expanded}
        onClick={(click) => {
          click.stopPropagation();
          onToggle();
        }}
      >
        <span className="msg-row-chevron" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </>
  );
}

interface MessageRowProps {
  envelope: TunnelEnvelope;
  agents: AgentInfo[];
  targets: MentionTarget[];
  replyLabel: string | null;
  showWorking: boolean;
}

function MessageRow({ envelope, agents, targets, replyLabel, showWorking }: MessageRowProps) {
  const [expanded, setExpanded] = useState(false);
  const name = displayNameFor(envelope.from);
  const collapsible = isCollapsible(envelope.body);
  const delivery = rowDeliveryFor(envelope, Date.now());

  // Row-wide click toggles collapse; clicks on links/chips/buttons keep
  // their own behavior (MentionChip already stops propagation).
  function handleRowClick(click: React.MouseEvent<HTMLElement>): void {
    if (!collapsible || (click.target as HTMLElement).closest('a, button')) return;
    setExpanded((current) => !current);
  }

  return (
    <article
      className={collapsible ? 'msg-row msg-row-collapsible' : 'msg-row'}
      id={messageRowId(envelope.id)}
      onClick={handleRowClick}
    >
      <span className="msg-row-av" aria-hidden="true">{initialFor(envelope.from)}</span>
      <div className="msg-row-body">
        <div className="msg-row-head">
          <strong>{name}</strong>
          <span className="msg-row-role">{roleFor(envelope.from, agents)}</span>
        </div>
        {replyLabel && (
          <span className="msg-row-reply">
            <span className="msg-row-reply-glyph" aria-hidden="true">↳</span>
            {replyLabel}
          </span>
        )}
        <CollapsibleBody
          body={envelope.body}
          targets={targets}
          expanded={expanded}
          onToggle={() => setExpanded((current) => !current)}
        />
        {delivery === 'failed' && <span className="msg-row-failed">Delivery failed</span>}
        {delivery === 'undelivered' && <span className="msg-row-failed">Not delivered</span>}
        {delivery === 'sending' && <span className="msg-row-queued">Sending…</span>}
        {showWorking && <span className="msg-row-working">Agent working…</span>}
      </div>
      <span className="msg-row-time">{formatClockTime(envelope.createdAt)}</span>
    </article>
  );
}

interface MessageFeedProps {
  conversation: Conversation;
  /** The WINDOWED slice (C1) — never the full lane transcript. */
  messages: TunnelEnvelope[];
  /** Full feed — reply parents may live outside the loaded lane window. */
  feed: TunnelEnvelope[];
  agents: AgentInfo[];
  targets: MentionTarget[];
  /** Rows above/below the window (C1 + M3 anchored review). */
  earlierCount: number;
  laterCount: number;
  onExtendWindow(): void;
  /** Reports the newest envelope createdAt genuinely shown in the foreground. */
  onSeen(seenCreatedAt: string): void;
}

export function MessageFeed({
  conversation, messages, feed, agents, targets, earlierCount, laterCount, onExtendWindow, onSeen,
}: MessageFeedProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const restoreRef = useRef<{ lane: string; done: boolean }>({ lane: '', done: false });
  const anchorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M7: the last wheel/touch gesture timestamp — "is the user actively
  // scrolling right now" (derivation lives in model.userScrollActive).
  const gestureAtRef = useRef<number | null>(null);
  const [dockVisible, setDockVisible] = useState(false);
  const lastEnvelope = messages[messages.length - 1];
  const feedEdge = `${conversation.id}:${lastEnvelope?.id ?? ''}:${lastEnvelope?.status ?? ''}:${messages.length}`;
  const working = workingAgentFor(messages, agents, Date.now());
  const groups = groupByDay(messages, new Date());

  function reportSeen(): void {
    if (atBottomRef.current && lastEnvelope && document.visibilityState === 'visible') {
      onSeen(lastEnvelope.createdAt);
    }
  }

  function trackScroll(): void {
    const body = bodyRef.current;
    if (!body) return;
    atBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < BOTTOM_SLACK_PX;
    reportSeen();
    // Reaching the live edge by hand dismisses the M7 dock.
    if (atBottomRef.current) setDockVisible(false);
    // The seat persists (debounced) so a reload restores this exact scroll.
    if (anchorTimer.current) clearTimeout(anchorTimer.current);
    const lane = conversation.id;
    const seatTop = body.scrollTop;
    anchorTimer.current = setTimeout(() => saveAnchor(lane, seatTop), 250);
  }

  function noteGesture(): void {
    gestureAtRef.current = Date.now();
  }

  // M7: the dock's jump — same smooth glide as the automatic follow.
  function jumpToNewest(): void {
    setDockVisible(false);
    if (bodyRef.current) scrollToLiveEdge(bodyRef.current);
  }

  // Opening a lane restores the saved seat; a lane never visited lands on the
  // newest word. Within a lane, follow the live edge only when already there.
  useEffect(() => {
    if (restoreRef.current.lane !== conversation.id) {
      restoreRef.current = { lane: conversation.id, done: false };
    }
  }, [conversation.id]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (!restoreRef.current.done && messages.length > 0) {
      restoreRef.current.done = true;
      const anchor = anchorFor(conversation.id);
      body.scrollTop = anchor ?? body.scrollHeight;
      atBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < BOTTOM_SLACK_PX;
      reportSeen();
      return;
    }
    if (atBottomRef.current) {
      body.scrollTop = body.scrollHeight;
      reportSeen();
      return;
    }
    // Send-and-know (M7): Chris's own fresh send pulls the feed to its row
    // with a smooth glide so "Sending… → Delivered" settles in view — unless
    // he is actively scrolling right now; then the dock offers the jump
    // instead of yanking the feed out from under him.
    if (isOwnFreshSend(lastEnvelope, Date.now())) {
      if (userScrollActive(gestureAtRef.current, Date.now())) setDockVisible(true);
      else scrollToLiveEdge(body);
    }
  }, [feedEdge]);

  if (messages.length === 0) {
    return (
      <div className="msg-feed" ref={bodyRef}>
        <div className="msg-feed-quiet">Nothing said yet — say the first word below.</div>
      </div>
    );
  }

  return (
    <div className="msg-feed" ref={bodyRef} onScroll={trackScroll} onWheel={noteGesture} onTouchMove={noteGesture}>
      {earlierCount > 0 && (
        <div className="msg-day">
          <button type="button" className="msg-window-pill" onClick={onExtendWindow}>
            Show earlier · {earlierCount}
          </button>
        </div>
      )}
      {groups.map((group) => (
        <React.Fragment key={group.dayKey}>
          <div className="msg-day">
            <span className="msg-day-pill">{group.label}</span>
          </div>
          {group.messages.map((envelope) => (
            <MessageRow
              key={envelope.id}
              envelope={envelope}
              agents={agents}
              targets={targets}
              replyLabel={replyLabelFor(envelope, feed)}
              showWorking={working !== null && envelope.id === lastEnvelope?.id}
            />
          ))}
        </React.Fragment>
      ))}
      {laterCount > 0 && (
        <div className="msg-day">
          <button type="button" className="msg-window-pill" onClick={onExtendWindow}>
            Show later · {laterCount}
          </button>
        </div>
      )}
      {dockVisible && (
        <div className={resolveStyle(NEW_MESSAGE_STYLE.dock)}>
          <button type="button" className={resolveStyle(NEW_MESSAGE_STYLE.pill)} onClick={jumpToNewest}>
            New message ↓
          </button>
        </div>
      )}
    </div>
  );
}
