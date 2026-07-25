// AI panel — the studio's right column (34%). Conversation renders the live
// thread projection in the reply grammar (caption + numbered state rows);
// Context carries session plumbing (runtime status, attach). Message rows
// already carry the future mention target slot (ChatRow.objectId) so the
// linked-mention engine can light workspace objects without reshaping this.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRecord, ProviderId, ThreadRecord } from '../../../../shared/project/schema.js';
import type { ThreadProjection } from '../../../../shared/provider/schema.js';
import type { AgentInfo } from '../../../lib/agentSocket/index.js';
import {
  agentActivity,
  avatarInitials,
  buildChatMessages,
  formatChatTime,
  type AgentActivity,
  type ChatMessage,
} from '../../../lib/chatModel/index.js';
import { buildTargets, type MentionTarget } from '../../../lib/mentions/index.js';
import { pinObject, useHighlightedObject } from '../../../lib/highlight/index.js';
import {
  approvalItemId,
  buildAttentionQueue,
  messageItemId,
  updateAttentionQueue,
  useAttention,
  type AttentionItem,
} from '../../../lib/attention/index.js';
import { latestChrisQuestion } from '../../../lib/messagingV2/index.js';
import { useMessagingFeed } from '../../../lib/messagingV2/feed/index.js';
import { MarkdownText } from '../../../lib/markdown/index.js';
import type { SessionUsage } from '../../../lib/cost/index.js';
import { ChatComposer } from './composer.js';
import { MentionText } from './mention/index.js';
import { ParityStrip } from './parity/index.js';
import './index.css';

/** A composer send waiting for its echo on the live stream. */
interface PendingSend {
  id: string;
  text: string;
  time: string;
}

export interface StudioChatPanelProps {
  project: ProjectRecord | null;
  thread: ThreadRecord | null;
  projection: ThreadProjection | null;
  runtimeAgent: AgentInfo | null;
  /** Aggregated token usage for the selected session — the parity readout's
   * projection source (already fetched by the shell; never refetched here). */
  sessionUsage: SessionUsage | null;
  /** Every known agent — the tunnel's roster hint and mention targets. */
  agents: AgentInfo[];
  onLaunch(provider: ProviderId): Promise<unknown>;
  onAttach(provider: ProviderId, sessionId: string, cwd?: string): Promise<void>;
  onOpenAgent(agentId: string): void;
}

type ChatTabId = 'context' | 'conversation' | 'evidence';

const CHAT_TABS: { id: ChatTabId; label: string }[] = [
  { id: 'context', label: 'Context' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'evidence', label: 'Evidence' },
];

function StateRow({ stateRow, index }: { stateRow: ChatMessage['rows'][number]; index: number }) {
  const highlighted = useHighlightedObject();
  const isLit = stateRow.objectId !== null && highlighted === stateRow.objectId;
  return (
    <button
      type="button"
      className={isLit ? 'st-srow st-srow-lit' : 'st-srow'}
      onClick={() => { if (stateRow.objectId) pinObject(stateRow.objectId); }}
    >
      <span className="st-srow-i">{String(index + 1).padStart(2, '0')}</span>
      {stateRow.mono && <span className="st-srow-o">{stateRow.mono}</span>}
      <span className="st-srow-w">{stateRow.text}</span>
      {stateRow.state && <span className={stateRow.settled ? 'st-srow-chip st-ok' : 'st-srow-chip'}>{stateRow.state}</span>}
    </button>
  );
}

function StateRows({ message }: { message: ChatMessage }) {
  return (
    <div className="st-rows">
      {message.rows.map((stateRow, index) => (
        <StateRow key={stateRow.id} stateRow={stateRow} index={index} />
      ))}
    </div>
  );
}

function ChatMessageBlock({ message, targets }: { message: ChatMessage; targets: MentionTarget[] }) {
  // Gold is granted by the amber engine, never claimed locally: this approval
  // reads gold only while it is THE thing needing Chris, and reads sage for a
  // breath right after it resolves.
  const attention = useAttention();
  const holdsGold = message.needsYou && attention.goldId === approvalItemId(message.id);
  const isSettling = attention.settlingId === approvalItemId(message.id);
  const blockClass = `st-msg${holdsGold ? ' st-msg-needs' : ''}${isSettling ? ' st-msg-settling' : ''}`;
  return (
    <div className={blockClass}>
      <span className="st-av" aria-hidden="true">{avatarInitials(message.author)}</span>
      <div className="st-msg-c">
        <div className={message.fromYou ? 'st-by st-by-you' : 'st-by'}>
          <b>{message.author}</b>
          {message.time && <span className="st-when">{message.time}</span>}
        </div>
        <div className={message.fromYou ? 'st-say st-say-you' : 'st-say'}>
          <MarkdownText
            text={message.caption}
            renderText={(plain) => <MentionText text={plain} targets={targets} />}
          />
        </div>
        {message.rows.length > 0 && <StateRows message={message} />}
      </div>
    </div>
  );
}

/** Optimistic echo of a composer send: rendered the instant Send fires, its
 * queued state living in the tiny mono meta line; it disappears when the real
 * user event lands on the live stream (the echo replaces it). */
function PendingSendBlock({ pending }: { pending: PendingSend }) {
  return (
    <div className="st-msg st-msg-pending">
      <span className="st-av" aria-hidden="true">C</span>
      <div className="st-msg-c">
        <div className="st-by st-by-you"><b>You</b><span className="st-when">{pending.time} · queued</span></div>
        <div className="st-say st-say-you"><MarkdownText text={pending.text} /></div>
      </div>
    </div>
  );
}

interface ConversationBodyProps {
  projection: ThreadProjection | null;
  thread: ThreadRecord | null;
  pendingSends: PendingSend[];
  targets: MentionTarget[];
}

function ConversationBody({ projection, thread, pendingSends, targets }: ConversationBodyProps) {
  const messages = useMemo(() => buildChatMessages(projection, undefined, targets), [projection, targets]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastMessageId = pendingSends[pendingSends.length - 1]?.id ?? messages[messages.length - 1]?.id;

  // Keep the newest exchange in view as live events land.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [lastMessageId]);

  if (!thread) return <div className="st-ai-quiet">Select a thread</div>;
  if (messages.length === 0 && pendingSends.length === 0) return <div className="st-ai-quiet">No conversation yet</div>;
  return (
    <div className="st-ai-body" ref={bodyRef}>
      {messages.map((message) => <ChatMessageBlock key={message.id} message={message} targets={targets} />)}
      {pendingSends.map((pending) => <PendingSendBlock key={pending.id} pending={pending} />)}
    </div>
  );
}

function AttachForm({ onAttach, project }: { onAttach: StudioChatPanelProps['onAttach']; project: ProjectRecord | null }) {
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [sessionId, setSessionId] = useState('');
  const [attaching, setAttaching] = useState(false);

  async function attach(): Promise<void> {
    setAttaching(true);
    try {
      await onAttach(provider, sessionId.trim(), project?.rootPath);
      setSessionId('');
    } finally {
      setAttaching(false);
    }
  }

  return (
    <div className="st-ctx-attach">
      <div className="st-ctx-label">Attach Saved Session</div>
      <select aria-label="Attachment provider" value={provider} onChange={(change) => setProvider(change.target.value as ProviderId)}>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <input aria-label="Provider session ID" placeholder="Session ID" value={sessionId} onChange={(change) => setSessionId(change.target.value)} />
      <button type="button" disabled={!sessionId.trim() || attaching} onClick={attach}>
        {attaching ? 'Attaching…' : 'Attach Session'}
      </button>
    </div>
  );
}

function ContextBody(props: StudioChatPanelProps) {
  if (!props.thread) return <div className="st-ai-quiet">Select a thread</div>;
  return (
    <div className="st-ai-body">
      <div className="st-ctx-section">
        <div className="st-ctx-label">Thread</div>
        <div className="st-ctx-line">{props.thread.title}</div>
        {props.project && <div className="st-ctx-sub">{props.project.name} · {props.project.rootPath}</div>}
      </div>
      <div className="st-ctx-section">
        <div className="st-ctx-label">Sessions</div>
        {props.thread.sessionReferences.length === 0 && <div className="st-ctx-sub">None attached</div>}
        {props.thread.sessionReferences.map((reference) => (
          <div key={`${reference.provider}:${reference.sessionId}`} className="st-ctx-sess">
            {reference.provider} · {reference.sessionId.slice(0, 8)}
          </div>
        ))}
        {props.runtimeAgent && (
          <button type="button" className="st-ctx-open" onClick={() => props.onOpenAgent(props.runtimeAgent!.agentId)}>
            Open Terminal — {props.runtimeAgent.provider} · {props.runtimeAgent.status}
          </button>
        )}
      </div>
      <AttachForm onAttach={props.onAttach} project={props.project} />
    </div>
  );
}

const ACTIVITY_LABELS: Record<AgentActivity, string> = {
  idle: 'Idle',
  working: 'Working',
  replying: 'Replying',
  ready: 'Ready',
  settled: 'Settled',
};

/** Drops queued sends once their text echoes back as a real user event. */
function settlePendingSends(pendingSends: PendingSend[], projection: ThreadProjection | null): PendingSend[] {
  if (pendingSends.length === 0 || !projection) return pendingSends;
  const echoed = new Set(
    projection.events.filter((event) => event.kind === 'user').map((event) => event.text.trim()),
  );
  const remaining = pendingSends.filter((pending) => !echoed.has(pending.text.trim()));
  return remaining.length === pendingSends.length ? pendingSends : remaining;
}

export function StudioChatPanel(props: StudioChatPanelProps) {
  const [activeTab, setActiveTab] = useState<ChatTabId>('conversation');
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Clock tick while an agent runs: Replying decays to Ready by time alone,
  // so the state must re-evaluate even when no new event forces a render.
  useEffect(() => {
    if (props.runtimeAgent?.status !== 'running') return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [props.runtimeAgent?.status]);

  // Settle optimistic rows when their echo arrives on the live stream.
  useEffect(() => {
    setPendingSends((current) => settlePendingSends(current, props.projection));
  }, [props.projection]);

  // Pending sends are per-agent turns; a thread switch orphans them.
  useEffect(() => {
    setPendingSends([]);
  }, [props.thread?.id]);

  function recordSend(text: string): void {
    setPendingSends((current) => [
      ...current,
      { id: `pending-${Date.now()}-${current.length}`, text, time: formatChatTime(new Date().toISOString()) },
    ]);
  }

  const activity = agentActivity(
    props.runtimeAgent?.status ?? null,
    props.projection?.events ?? [],
    pendingSends.length > 0,
    nowMs,
  );

  // The resolvable mention universe: agent names + this project's threads.
  const mentionTargets = useMemo(
    () => buildTargets(props.agents, props.project?.threads ?? []),
    [props.agents, props.project],
  );

  // Amber engine feed. The tunnel feed lives HERE (not in the Tunnel tab) so
  // a failed delivery claims attention whichever lens is open. Clicking
  // through a failed send dismisses it — that is its resolution. A lane whose
  // newest word asks for Chris joins the queue the same way; opening that
  // lane in the messenger dismisses it.
  const { feed: tunnelFeed } = useMessagingFeed(props.agents);
  const [dismissedNeeds, setDismissedNeeds] = useState<ReadonlySet<string>>(() => new Set<string>());
  useEffect(() => {
    const queue = buildAttentionQueue(props.projection, tunnelFeed, dismissedNeeds);
    const question = latestChrisQuestion(tunnelFeed);
    const questionId = question ? messageItemId(question.envelopeId) : null;
    if (question && questionId && !dismissedNeeds.has(questionId)
      && !queue.some((item) => item.id === questionId)) {
      // A person waiting on Chris outranks failed sends, not an open
      // approval. (kind reuses 'failed-message' — the engine only reads ids;
      // the union stays untouched because the attention lib is shared.)
      const asked: AttentionItem = { id: questionId, kind: 'failed-message', threadId: null, since: question.since };
      queue.splice(queue[0]?.kind === 'approval' ? 1 : 0, 0, asked);
    }
    updateAttentionQueue(queue);
  }, [props.projection, tunnelFeed, dismissedNeeds]);
  function resolveNeed(itemId: string): void {
    setDismissedNeeds((current) => new Set(current).add(itemId));
  }

  return (
    <aside className="studio-ai">
      <div className="st-ai-head">
        {CHAT_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === activeTab ? 'studio-tab studio-tab-on' : 'studio-tab'}
            onClick={() => setActiveTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <span className={`st-ai-state st-act-${activity}`}>
          <span className="st-ai-state-dot" />
          {ACTIVITY_LABELS[activity]}
        </span>
      </div>

      {activeTab === 'conversation' && (
        <ParityStrip agent={props.runtimeAgent} usage={props.sessionUsage} />
      )}
      {activeTab === 'conversation' && (
        <ConversationBody projection={props.projection} thread={props.thread} pendingSends={pendingSends} targets={mentionTargets} />
      )}
      {activeTab === 'context' && <ContextBody {...props} />}
      {activeTab === 'evidence' && <div className="st-ai-quiet">Nothing captured yet</div>}

      {activeTab === 'conversation' && (
        <ChatComposer thread={props.thread} runtimeAgent={props.runtimeAgent} onLaunch={props.onLaunch} onSent={recordSend} />
      )}
    </aside>
  );
}
