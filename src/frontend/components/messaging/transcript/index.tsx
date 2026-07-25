// One conversation's transcript + composer. Rows keep the anti-prose grammar:
// tiny mono speaker label, the body, delivery state in the meta line. No
// badges, no pills. The amber engine may grant ONE row gold (a failed send
// that needs Chris); clicking that row's meta line resolves it and the gold
// releases to sage.
import React, { useEffect, useRef, useState } from 'react';
import { messageItemId, useAttention } from '../../../lib/attention/index.js';
import { anchorFor, saveAnchor } from '../../../lib/readCursor/index.js';
import {
  CHRIS,
  formatRoute,
  statusMeta,
  type Conversation,
  type TunnelEnvelope,
} from '../../../lib/messagingV2/index.js';
import { avatarInitials, formatChatTime } from '../../../lib/chatModel/index.js';
import { clearDraft, loadDraft, saveDraft } from '../../../lib/composerDraft/index.js';
import type { MentionTarget } from '../../../lib/mentions/index.js';
import { MarkdownText } from '../../../lib/markdown/index.js';
import { MentionText } from '../../studio/chat/mention/index.js';
import './index.css';

/** Chris reads as You; an agent↔agent DM surfacing in a lane keeps its full
 * route so the lane never misattributes a sidebar between two agents. */
function authorLabel(envelope: TunnelEnvelope, kind: Conversation['kind']): string {
  if (envelope.from === CHRIS) return 'You';
  if (kind === 'dm' && envelope.to !== CHRIS) return formatRoute(envelope);
  return envelope.from;
}

interface RowMetaProps {
  envelope: TunnelEnvelope;
  kind: Conversation['kind'];
  liveNames: string[];
}

function RowMeta({ envelope, kind, liveNames }: RowMetaProps) {
  return (
    <>
      <b>{authorLabel(envelope, kind)}</b>
      {' · '}{formatChatTime(envelope.createdAt)}
      {envelope.delivery === 'interrupt' && ' · interrupt'}
      {' · '}
      <span className={`st-tn-status st-tn-${envelope.status}`}>{statusMeta(envelope, liveNames)}</span>
    </>
  );
}

interface TranscriptRowProps extends RowMetaProps {
  targets: MentionTarget[];
  onResolve(itemId: string): void;
}

function TranscriptRow({ envelope, kind, liveNames, targets, onResolve }: TranscriptRowProps) {
  const attention = useAttention();
  const itemId = messageItemId(envelope.id);
  const holdsGold = attention.goldId === itemId;
  const isSettling = attention.settlingId === itemId;
  const fromYou = envelope.from === CHRIS;
  const rowClass = `st-msg${holdsGold ? ' st-tn-gold' : ''}${isSettling ? ' st-tn-settling' : ''}`;
  const metaClass = `st-by st-tn-route${fromYou ? ' st-by-you' : ''}`;
  // Resolution is an explicit affordance — the gold meta line is a real
  // button. Nothing resolves by bubbling: clicks on the body or a mention
  // inside it can never release the amber.
  const initials = avatarInitials(fromYou ? 'You' : envelope.from);
  return (
    <div className={rowClass}>
      <span className="st-av" aria-hidden="true">{initials}</span>
      <div className="st-msg-c">
        {holdsGold ? (
          <button type="button" className={`${metaClass} st-tn-resolve`} onClick={() => onResolve(itemId)}>
            <RowMeta envelope={envelope} kind={kind} liveNames={liveNames} />
          </button>
        ) : (
          <div className={metaClass}>
            <RowMeta envelope={envelope} kind={kind} liveNames={liveNames} />
          </div>
        )}
        <div className={`st-say st-tn-body${fromYou ? ' st-say-you' : ''}`}>
          <MarkdownText
            text={envelope.body}
            renderText={(plain) => <MentionText text={plain} targets={targets} />}
          />
        </div>
      </div>
    </div>
  );
}

const BOTTOM_SLACK_PX = 48;

interface TranscriptProps {
  conversation: Conversation;
  messages: TunnelEnvelope[];
  liveNames: string[];
  targets: MentionTarget[];
  onResolve(itemId: string): void;
  /** Reports the newest envelope createdAt genuinely shown in the foreground
   * — the ReadCursor advances on THIS, never on merely opening the lane. */
  onSeen(seenCreatedAt: string): void;
}

export function Transcript({ conversation, messages, liveNames, targets, onResolve, onSeen }: TranscriptProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const restoreRef = useRef<{ lane: string; done: boolean }>({ lane: '', done: false });
  const anchorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEnvelope = messages[messages.length - 1];
  const feedEdge = `${conversation.id}:${lastEnvelope?.id ?? ''}:${lastEnvelope?.status ?? ''}:${messages.length}`;

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
    // The seat persists (debounced) so a reload restores this exact scroll.
    if (anchorTimer.current) clearTimeout(anchorTimer.current);
    const lane = conversation.id;
    const seatTop = body.scrollTop;
    anchorTimer.current = setTimeout(() => saveAnchor(lane, seatTop), 250);
  }

  // Opening a lane restores the saved seat (open ≠ read, C21); a lane never
  // visited lands on the newest word. Within a lane, follow the live edge
  // only when already reading it — scrolled-up history reading is never
  // yanked to the bottom by an arriving envelope.
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
    }
  }, [feedEdge]);

  if (messages.length === 0) return <div className="st-ai-quiet">Nothing said yet</div>;
  return (
    <div className="st-ai-body st-tunnel" ref={bodyRef} onScroll={trackScroll}>
      {messages.map((envelope) => (
        <TranscriptRow
          key={envelope.id}
          envelope={envelope}
          kind={conversation.kind}
          liveNames={liveNames}
          targets={targets}
          onResolve={onResolve}
        />
      ))}
    </div>
  );
}

interface MessengerComposerProps {
  conversation: Conversation;
  onSend(body: string): Promise<void>;
}

export function MessengerComposer({ conversation, onSend }: MessengerComposerProps) {
  const [draft, setDraft] = useState(() => loadDraft(conversation.id));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setDraft(loadDraft(conversation.id));
    setError(null);
  }, [conversation.id]);

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setDraft('');
      clearDraft(conversation.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(press: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (press.key !== 'Enter' || press.shiftKey) return;
    press.preventDefault();
    void send();
  }

  return (
    <div className="st-ai-foot">
      {error && <div className="st-ai-error">{error}</div>}
      <div className="st-composer">
        <div className="st-ms-to">To {conversation.title}</div>
        <textarea
          aria-label={`Message ${conversation.title}`}
          placeholder="Say it in your own words…"
          value={draft}
          onChange={(change) => {
            const nextDraft = change.target.value;
            setDraft(nextDraft);
            saveDraft(conversation.id, nextDraft);
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="st-composer-foot">
          <span className="st-composer-hint">⏎ send</span>
          <button type="button" className="st-send" aria-label="Send" disabled={!draft.trim() || sending} onClick={() => void send()}>↑</button>
        </div>
      </div>
    </div>
  );
}
