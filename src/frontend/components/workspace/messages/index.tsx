// Messages tab — rebuilt to the storyboard vision (docs/plans/messaging-ui-rebuild.md).
// This view is a lens over the capability feed, room threads, roster and read
// cursors; it owns no message store. All visual decisions live in tokens.css,
// all derived behavior in model.ts — the components only render and wire.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ProjectRecord } from '../../../../shared/project/schema.js';
import type { AgentInfo } from '../../../lib/agentSocket/index.js';
import {
  buildAttentionQueue,
  messageItemId,
  updateAttentionQueue,
} from '../../../lib/attention/index.js';
import { buildTargets } from '../../../lib/mentions/index.js';
import {
  buildConversations,
  laneRosterFor,
  messagesFor,
  type Conversation,
  type ConversationId,
  type TunnelEnvelope,
} from '../../../lib/messagingV2/index.js';
import { useMessagingFeed } from '../../../lib/messagingV2/feed/index.js';
import { usePeople } from '../../../lib/tunnelModel/people/index.js';
import { buildPanelLanes } from '../../../lib/tunnelModel/panel/index.js';
import {
  advanceCursor,
  saveLane,
  savedLane,
  unreadCountFor,
  useReadCursors,
} from '../../../lib/readCursor/index.js';
import {
  DENSITY_SCALE,
  MESSAGING_SETTINGS,
  clampRailWidth,
  composerTargetsFor,
  distinctRailLabels,
  knownAgentsFor,
  loadRailWidths,
  reviewLanesFor,
  roomLabelFor,
  saveRailWidths,
  restoreDecision,
  visibleLanesFor,
  windowMessages,
  workingAgentFor,
  type RailWidths,
} from './model.js';
import { SHELL_STYLE, resolveStyle } from './styles/index.js';
import { beginResize, nudgeWidth } from './resize/index.js';
import { postJson, useLaneFlows } from './flows/index.js';
import { RoomsRail } from './rail/index.js';
import { MessageFeed, messageRowId } from './thread/index.js';
import { ComposerBar } from './composer/index.js';
import { ContextPanel } from './context/index.js';
import './index.css';

interface MessagesViewProps {
  agents: AgentInfo[];
  /** Roster hydration signal — the D3 restore machine waits on it (S7). */
  agentsLoaded: boolean;
  projects: ProjectRecord[];
  project: ProjectRecord | null;
  openRequest?: MessagesOpenRequest | null;
}

export interface MessagesOpenRequest {
  id: string;
  nonce: number;
}

/** The connection strip's text (null = hidden) — extracted for complexity. */
function connStripText(loadError: boolean, connection: 'connected' | 'disconnected', feedLoaded: boolean): string | null {
  if (loadError) return 'Messaging unavailable — retrying…';
  if (connection === 'disconnected' && feedLoaded) return 'Reconnecting…';
  return null;
}

export function MessagesView({ agents, agentsLoaded, projects, openRequest }: MessagesViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const { feed, threads, feedLoaded, loadError, connection, send: sendMessage } = useMessagingFeed(agents);
  const cursors = useReadCursors();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<ConversationId | null>(null);
  const [contextOpen, setContextOpen] = useState(true);
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [pendingReview, setPendingReview] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  // Thread window (C1): how many rows render, and the M3 review anchor the
  // window bounds around. Resets on lane switch; paging drops the anchor.
  const [threadWindow, setThreadWindow] = useState<{ count: number; anchorId?: string }>(
    { count: MESSAGING_SETTINGS.thread.windowSize },
  );
  const [widths, setWidths] = useState<RailWidths>(() => loadRailWidths());
  const widthsRef = useRef(widths);
  widthsRef.current = widths; const resizeDeps = { rootRef, widthsRef, setWidths, setResizing };

  // Durable-first people directory (ruling S3): the roster that materializes
  // DM lanes is the PeopleHub union — durable agents (incl. registered
  // external sessions) plus runtime-only PTYs. visibleLanesFor (C3) then
  // prunes to lanes Chris is party to — "registered" now means "known to the
  // people directory", so the external chief's empty lane survives the prune.
  const { people, archivedLaneIds, loaded: peopleLoaded, stale: peopleStale } = usePeople();
  const peopleTitles = useMemo(() => people.map((person) => ({ title: person.name })), [people]);
  const rosterAgents = useMemo(
    () => laneRosterFor(agents, people.map((person) => ({ name: person.name, provider: person.provider as AgentInfo['provider'] }))),
    [agents, people],
  );
  const conversations = useMemo(
    () => visibleLanesFor(buildConversations(threads, feed, rosterAgents), feed, peopleTitles),
    [threads, feed, rosterAgents, peopleTitles],
  );
  // The ONE row set both rails render (Task 2.3) — agentId-keyed buckets.
  const panel = useMemo(() => buildPanelLanes(conversations, people, feed, archivedLaneIds), [conversations, people, feed, archivedLaneIds]);
  // Collision-suffixed labels (C2) — computed over the visible set so the
  // rail rows and the thread topbar always agree.
  const labels = useMemo(() => distinctRailLabels(conversations), [conversations]);
  // Known agents (live + exited + feed-history names) feed the M5 pickers.
  const knownAgents = useMemo(() => knownAgentsFor(agents, feed), [agents, feed]);
  const flows = useLaneFlows({
    openLane: (laneId) => { setSelectedId(laneId); saveLane(laneId); },
  });
  const targets = useMemo(
    () => buildTargets(agents, projects.flatMap((entry) => entry.threads)),
    [agents, projects],
  );
  // The composer picker draws from the KNOWN-agents union (M8a): the live
  // roster alone leaves the picker empty whenever no agent process is up.
  const composerTargets = useMemo(() => composerTargetsFor(knownAgents), [knownAgents]);

  // Unread per lane — DERIVED from feed past each ReadCursor (C21).
  const unread = useMemo(() => {
    const counts: Record<ConversationId, number> = {};
    for (const lane of conversations) counts[lane.id] = unreadCountFor(feed, lane.id, cursors);
    return counts;
  }, [feed, conversations, cursors]);

  // The density knob (owner decision): one CSS var rescales the whole tab.
  useLayoutEffect(() => {
    rootRef.current?.style.setProperty('--msg-scale', String(DENSITY_SCALE[MESSAGING_SETTINGS.density]));
  }, []);

  // Rail widths ride the same seam: two CSS vars, persisted as one typed object.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.setProperty('--msg-rail-w', `${widths.rail}px`);
    root.style.setProperty('--msg-context-w', `${widths.context}px`);
  }, [widths]);

  // Keep the app-wide amber engine fed — unchanged behavior (§6.9).
  useEffect(() => {
    updateAttentionQueue(buildAttentionQueue(null, feed, dismissed));
  }, [feed, dismissed]);

  // First open restores the lane Chris was in (D3, ruling S7): the pure
  // restore machine retains the remembered id while feed/rooms/roster hydrate
  // and falls back only after ALL of them settle. A fallback selection is
  // never saved — the remembered preference survives a broken reload.
  useEffect(() => {
    const decision = restoreDecision({
      selectedId,
      remembered: savedLane() ?? null,
      conversationIds: conversations.map((lane) => lane.id),
      // People joined the lane derivation (S3) — the restore machine waits on
      // the directory settling too, same S7 rule as the other three sources.
      feedLoaded, roomsLoaded: true, agentsLoaded: agentsLoaded && peopleLoaded,
    });
    if (decision.kind === 'restore' || decision.kind === 'fallback') setSelectedId(decision.id);
  }, [selectedId, conversations, feedLoaded, agentsLoaded, peopleLoaded]);

  useEffect(() => {
    if (!openRequest || !conversations.some((lane) => lane.id === openRequest.id)) return;
    setSelectedId(openRequest.id);
    saveLane(openRequest.id);
  }, [openRequest?.nonce, conversations]);

  const selected = flows.resolveSelected(conversations, selectedId);

  function select(conversation: Conversation): void {
    setSelectedId(conversation.id);
    saveLane(conversation.id);
    setThreadWindow({ count: MESSAGING_SETTINGS.thread.windowSize }); // window + anchor reset per lane
    setRailOpen(false); // phone layout: picking a lane dismisses the rail overlay
  }

  // DM flow (M5): the lane is derived, so opening it IS creating it — the
  // overlay in useLaneFlows covers the not-yet-derived lane until the first
  // envelope lands.
  function openDm(name: string): void {
    select(flows.openDm(name));
  }

  async function send(body: string): Promise<void> {
    if (!selected) return;
    // The hook owns optimism: 'queued' until the committed echo settles.
    const recipient = selected.kind === 'dm' ? selected.title : selected.id;
    const sent = await sendMessage({ 'to': recipient, body });
    if (!sent) throw new Error('send failed — the messaging capability is unavailable');
  }

  // Review = scroll the thread to the failed row AND resolve its amber item.
  // The row may sit outside the current lane or the loaded window: locate it
  // in the feed first, switch lane when it lives elsewhere (the lane-load
  // effect backfills its history), and scroll only once the row is actually
  // rendered. If it never renders, the panel says so — no silent no-op.
  function review(envelopeId: string): void {
    setDismissed((current) => new Set(current).add(messageItemId(envelopeId)));
    setReviewNote(null);
    const lanes = reviewLanesFor(feed, envelopeId);
    if (!lanes) {
      setReviewNote('That message is no longer in the loaded feed.');
      return;
    }
    // C3: the target may live only in pruned lanes (agent↔agent traffic
    // Chris is not party to) — say so honestly instead of a dead jump.
    const reachable = lanes.filter((laneId) => conversations.some((lane) => lane.id === laneId));
    if (reachable.length === 0) {
      setReviewNote('That message lives in an agent↔agent lane outside your conversations.');
      return;
    }
    if (!selected || !reachable.includes(selected.id)) {
      setSelectedId(reachable[0]);
      saveLane(reachable[0]);
    }
    // M3: anchor the thread window around the target so a failure older
    // than the tail window still renders.
    setThreadWindow({ count: MESSAGING_SETTINGS.thread.windowSize, anchorId: envelopeId });
    setPendingReview(envelopeId);
  }

  const laneMessages = selected ? messagesFor(feed, selected.id) : [];
  const working = workingAgentFor(laneMessages, agents, Date.now());
  // C1: only the windowed slice ever renders — never the full journal.
  const thread = windowMessages(laneMessages, threadWindow.count, threadWindow.anchorId);

  // Scroll the moment the review target's row exists — lane switches and
  // history backfills land asynchronously…
  useEffect(() => {
    if (!pendingReview) return;
    const target = document.getElementById(messageRowId(pendingReview));
    target?.scrollIntoView({ block: 'center' });
    if (target) setPendingReview(null);
  }, [pendingReview, thread.messages]);

  // …but never wait forever: past the typed timeout, say why honestly.
  useEffect(() => {
    if (!pendingReview) return;
    const timer = setTimeout(() => {
      setPendingReview(null); setReviewNote('Could not locate that message in this lane — it may sit outside the loaded history.');
    }, MESSAGING_SETTINGS.review.scrollTimeoutMs);
    return () => clearTimeout(timer);
  }, [pendingReview]);
  // Panel state is a set of style-block attachments swapped through the one
  // resolver seam (doctrine §B) — never ad-hoc class string math.
  const viewClass = resolveStyle(
    SHELL_STYLE.base,
    !contextOpen && SHELL_STYLE.contextClosed,
    railCollapsed && SHELL_STYLE.railCollapsed,
    railOpen && SHELL_STYLE.railOverlayOpen,
    resizing && SHELL_STYLE.resizing,
  );

  return (
    <section className={viewClass} ref={rootRef} aria-label="Messages">
      <RoomsRail
        conversations={conversations}
        panel={panel}
        archivedLaneIds={archivedLaneIds}
        peopleStale={peopleStale}
        labels={labels}
        unread={unread}
        selectedId={selectedId}
        agents={agents}
        knownAgents={knownAgents}
        collapsed={railCollapsed}
        onToggleCollapse={() => setRailCollapsed((current) => !current)}
        onSelect={select}
        onOpenDm={openDm}
        onSpawnAgent={flows.spawnAgent}
      />
      <main className="msg-thread">
        {selected && (
          <div className="msg-thread-topbar">
            <button
              type="button"
              className="msg-ghost"
              aria-label="Show conversations"
              title="Show conversations"
              onClick={() => setRailOpen((current) => !current)}
            >
              <span className="msg-ghost-glyph msg-glyph-list" aria-hidden="true" />
            </button>
            <span className="msg-thread-title">
              {selected.kind === 'dm'
                ? `@ ${labels.get(selected.id) ?? selected.title}`
                : `# ${labels.get(selected.id) ?? roomLabelFor(selected)}`}
            </span>
          </div>
        )}
        {selected ? (
          <>
            <MessageFeed
              conversation={selected}
              messages={thread.messages}
              feed={feed}
              agents={agents}
              targets={targets}
              earlierCount={thread.earlierCount}
              laterCount={thread.laterCount}
              onExtendWindow={() => setThreadWindow((current) => ({ count: current.count + MESSAGING_SETTINGS.thread.windowSize }))}
              onSeen={(seenCreatedAt) => advanceCursor(selected.id, seenCreatedAt)}
            />
            {connStripText(loadError, connection, feedLoaded) !== null && (
              <div className="msg-conn-strip" role="status">{connStripText(loadError, connection, feedLoaded)}</div>
            )}
            <ComposerBar conversation={selected} targets={composerTargets} onSend={send} />
          </>
        ) : (
          <div className="msg-temp">No conversations yet</div>
        )}
        {selected && (
          <button
            type="button"
            className="msg-ghost msg-context-reopen"
            aria-label="Show context panel"
            title="Show context panel"
            onClick={() => setContextOpen(true)}
          >
            <span className="msg-ghost-glyph msg-glyph-show-context" aria-hidden="true" />
          </button>
        )}
      </main>
      {selected && (
        <ContextPanel
          conversation={selected}
          laneLabel={labels.get(selected.id) ?? (selected.kind === 'dm' ? selected.title : roomLabelFor(selected))}
          messages={laneMessages}
          agents={agents}
          unreadCount={unread[selected.id] ?? 0}
          working={working}
          reviewNote={reviewNote}
          onReview={review}
          onCollapse={() => setContextOpen(false)}
        />
      )}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize conversations panel"
        tabIndex={0}
        className="msg-resize msg-resize-rail"
        onPointerDown={beginResize(resizeDeps, 'rail')}
        onKeyDown={nudgeWidth(resizeDeps, 'rail')}
      />
      {selected && contextOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize context panel"
          tabIndex={0}
          className="msg-resize msg-resize-context"
          onPointerDown={beginResize(resizeDeps, 'context')}
          onKeyDown={nudgeWidth(resizeDeps, 'context')}
        />
      )}
    </section>
  );
}
