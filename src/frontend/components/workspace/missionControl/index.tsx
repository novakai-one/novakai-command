import React, { useEffect, useMemo, useState } from 'react';
import type { ProjectRecord, ThreadRecord } from '../../../../shared/project/schema.js';
import type { ThreadProjection } from '../../../../shared/provider/schema.js';
import type { AgentInfo } from '../../../lib/agentSocket/index.js';
import {
  buildAttentionQueue,
  messageItemId,
  updateAttentionQueue,
  useAttention,
  type AttentionView,
} from '../../../lib/attention/index.js';
import type { SessionUsage } from '../../../lib/cost/index.js';
import { buildTargets } from '../../../lib/mentions/index.js';
import {
  advanceCursor,
  saveLane,
  savedLane,
  useReadCursors,
} from '../../../lib/readCursor/index.js';
import {
  buildConversations,
  dmId,
  dmLaneFor,
  laneRosterFor,
  latestChrisQuestion,
  messagesFor,
  resolveSelectedLane,
  type Conversation,
  type ConversationId,
  type TunnelEnvelope,
} from '../../../lib/messagingV2/index.js';
import { useMessagingFeed } from '../../../lib/messagingV2/feed/index.js';
import { usePeople, visibleLanesFor } from '../../../lib/tunnelModel/people/index.js';
import { buildPanelLanes } from '../../../lib/tunnelModel/panel/index.js';
import { MessengerComposer, Transcript } from '../../messaging/transcript/index.js';
import { MISSION_ROOM_CONVERSATION_ID, MISSION_ROOM_V1_TARGET, useMissionSnapshot } from '../../../lib/missionRoom/index.js';
import { MissionRoom, MissionRoomHero } from './room/index.js';
import {
  attentionApproval,
  liveMissionAgents,
  missionHealth,
} from './model.js';
import { MissionEvidence, MissionHealthBar, MissionLiveHero, MissionRail } from './panels/index.js';
import './index.css';

export interface MissionConfidence {
  score: number;
  label: string;
  evidence: string;
}

export interface MissionControlProps {
  agents: AgentInfo[];
  project: ProjectRecord | null;
  thread: ThreadRecord | null;
  projection: ThreadProjection | null;
  attention: AttentionView;
  usage?: SessionUsage | null;
  confidence?: MissionConfidence | null;
  selectedAgentId?: string | null;
  onSelectAgent?(agentId: string): void;
  onSelectThread?(threadId: string): void;
  onReviewAttention?(): void;
}

const LEFT_OPEN_KEY = 'novakai.mission.leftRailOpen';
const RIGHT_OPEN_KEY = 'novakai.mission.rightRailOpen';
const LEFT_WIDTH_KEY = 'novakai.mission.leftRailWidth';
const RIGHT_WIDTH_KEY = 'novakai.mission.rightRailWidth';

/** Pinned read-only Mission Room entry, always first in the mission rooms list. */
const MISSION_ROOM_ENTRY: Conversation = { id: MISSION_ROOM_CONVERSATION_ID, kind: 'room', title: 'Mission Room', members: [] };

function restoredBoolean(storageKey: string, fallback: boolean): boolean {
  const stored = localStorage.getItem(storageKey);
  return stored === null ? fallback : stored !== 'false';
}

function restoredWidth(storageKey: string, fallback: number, minimum: number, maximum: number): number {
  const stored = Number(localStorage.getItem(storageKey));
  return Number.isFinite(stored) && stored >= minimum && stored <= maximum ? stored : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function liveMissionFacts(feed: TunnelEnvelope[], selected: Conversation | null, squad: AgentInfo[], running: number): string {
  return [
    selected ? `${messagesFor(feed, selected.id).length} messages` : null,
    squad.length > 0 ? `${running} of ${squad.length} agents live` : null,
  ].filter(Boolean).join(' · ');
}

/** Lane to select on first render: the remembered one when it still exists. */
function restoredLane(conversations: Conversation[]): ConversationId | null {
  const remembered = savedLane();
  if (remembered === MISSION_ROOM_CONVERSATION_ID) return remembered;
  return remembered && conversations.some((lane) => lane.id === remembered) ? remembered : null;
}

export function MissionControl(props: MissionControlProps) {
  const [leftOpen, setLeftOpen] = useState(() => restoredBoolean(LEFT_OPEN_KEY, true));
  const [rightOpen, setRightOpen] = useState(() => restoredBoolean(RIGHT_OPEN_KEY, true));
  const [leftWidth, setLeftWidth] = useState(() => restoredWidth(LEFT_WIDTH_KEY, 224, 180, 360));
  const [rightWidth, setRightWidth] = useState(() => restoredWidth(RIGHT_WIDTH_KEY, 304, 240, 440));
  const [draggingRail, setDraggingRail] = useState<'left' | 'right' | null>(null);
  const [selectedId, setSelectedId] = useState<ConversationId | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  // Overlay lane (mission_visual-truth defect 1): a person/archived row whose
  // lane isn't derivable yet still OPENS — the overlay stands in until history
  // derives the real lane. Shared derivation, same as the Messages tab.
  const [overlayLane, setOverlayLane] = useState<Conversation | null>(null);
  const { feed, threads, send: sendMessage } = useMessagingFeed(props.agents);
  // Durable-first people directory (rulings S3 + D1/D2): the same source and
  // the same C3 pruning the Messages tab uses — one lane set, two chromes.
  const { people, archivedLaneIds, stale: peopleStale } = usePeople();
  const peopleRoster = useMemo(
    () => people.map((person) => ({ name: person.name, provider: person.provider as AgentInfo['provider'] })),
    [people],
  );
  const peopleTitles = useMemo(() => people.map((person) => ({ title: person.name })), [people]);
  const rosterAgents = useMemo(
    () => laneRosterFor(props.agents, people.map((person) => ({ name: person.name, provider: person.provider as AgentInfo['provider'] }))),
    [props.agents, people],
  );
  const conversations = useMemo(
    () => visibleLanesFor(buildConversations(threads, feed, rosterAgents), feed, peopleTitles),
    [threads, feed, rosterAgents, peopleTitles],
  );
  const panel = useMemo(() => buildPanelLanes(conversations, people, feed, archivedLaneIds), [conversations, people, feed, archivedLaneIds]);
  // Room-composer roster: live people (the external chief is invitable too).
  const roster = useMemo(
    () => panel.live.map((laneRow) => ({ name: laneRow.person?.name ?? laneRow.conversationId, provider: (laneRow.person?.provider ?? 'claude') as AgentInfo['provider'] })),
    [panel.live],
  );
  const missionRooms = [MISSION_ROOM_ENTRY, ...panel.rooms];
  const selected = resolveSelectedLane(conversations, overlayLane, selectedId);
  // S2 hard boundary: while the pinned room is selected the whole mission
  // surface renders from the snapshot — no live squad, transcript, composer.
  const snapshotMode = selectedId === MISSION_ROOM_CONVERSATION_ID;
  const missionSnapshot = useMissionSnapshot(snapshotMode ? MISSION_ROOM_V1_TARGET : null);
  const liveNames = roster.map((entry) => entry.name);
  const targets = useMemo(
    () => buildTargets(props.agents, props.project?.threads ?? []),
    [props.agents, props.project],
  );
  const cursors = useReadCursors();
  const messageAttention = useAttention();
  const question = useMemo(() => latestChrisQuestion(feed), [feed]);
  const squad = snapshotMode ? [] : liveMissionAgents(props.agents, props.project?.id, props.thread?.id);
  const approval = attentionApproval(props.projection, props.attention);
  const health = missionHealth(props.projection, squad, props.usage ?? null);
  const running = squad.filter((agent) => agent.status === 'running').length;
  const title = props.thread?.title ?? props.project?.name ?? 'No mission selected';
  const missionFacts = liveMissionFacts(feed, selected, squad, running);

  useEffect(() => {
    if (selectedId || conversations.length === 0) return;
    setSelectedId(restoredLane(conversations) ?? conversations[0].id);
  }, [selectedId, conversations]);


  useEffect(() => {
    updateAttentionQueue(buildAttentionQueue(null, feed, dismissed));
  }, [feed, dismissed]);

  function selectConversation(conversation: Conversation): void {
    setSelectedId(conversation.id);
    saveLane(conversation.id);
    // The pinned snapshot entry is never an overlay; an underived lane
    // (durable-only person, archived row, fresh room) becomes the overlay.
    setOverlayLane(
      conversation.id === MISSION_ROOM_CONVERSATION_ID || conversations.some((lane) => lane.id === conversation.id)
        ? null
        : conversation,
    );
    if (question && messageAttention.goldId === messageItemId(question.envelopeId)
      && conversation.id === question.conversationId) {
      setDismissed((current) => new Set(current).add(messageItemId(question.envelopeId)));
    }
  }

  function selectPerson(agent: AgentInfo): void {
    props.onSelectAgent?.(agent.agentId);
    // Defect 1 fix: no derived lane is NO LONGER a silent noop — fall back to
    // the overlay lane so every live person row opens its conversation.
    const conversation = conversations.find((candidate) => candidate.id === dmId(agent.title))
      ?? dmLaneFor(agent.title);
    selectConversation(conversation);
  }

  async function send(body: string): Promise<void> {
    if (!selected) return;
    // The hook owns optimism: 'queued' until the committed echo settles.
    const recipient = selected.kind === 'dm' ? selected.title : selected.id;
    const sent = await sendMessage({ 'to': recipient, body });
    if (!sent) throw new Error('send failed — the messaging capability is unavailable');
  }

  function toggleRail(side: 'left' | 'right'): void {
    const setOpen = side === 'left' ? setLeftOpen : setRightOpen;
    const storageKey = side === 'left' ? LEFT_OPEN_KEY : RIGHT_OPEN_KEY;
    setOpen((open) => {
      localStorage.setItem(storageKey, String(!open));
      return !open;
    });
  }

  function resizeRail(side: 'left' | 'right', move: React.PointerEvent<HTMLDivElement>): void {
    if (draggingRail !== side) return;
    const bounds = move.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    if (side === 'left') setLeftWidth(clamp(move.clientX - bounds.left, 180, 360));
    else setRightWidth(clamp(bounds.right - move.clientX, 240, 440));
  }

  function finishResize(side: 'left' | 'right', release: React.PointerEvent<HTMLDivElement>): void {
    if (draggingRail !== side) return;
    const bounds = release.currentTarget.parentElement?.getBoundingClientRect();
    const width = bounds
      ? side === 'left'
        ? clamp(release.clientX - bounds.left, 180, 360)
        : clamp(bounds.right - release.clientX, 240, 440)
      : side === 'left' ? leftWidth : rightWidth;
    if (side === 'left') setLeftWidth(width);
    else setRightWidth(width);
    if (release.currentTarget.hasPointerCapture(release.pointerId)) {
      release.currentTarget.releasePointerCapture(release.pointerId);
    }
    localStorage.setItem(side === 'left' ? LEFT_WIDTH_KEY : RIGHT_WIDTH_KEY, String(width));
    setDraggingRail(null);
  }

  function railHandleProps(side: 'left' | 'right') {
    return {
      'data-dragging': draggingRail === side ? '' : undefined,
      'role': 'separator' as const,
      'aria-label': side === 'left' ? 'Resize mission rail' : 'Resize live squad rail',
      'aria-orientation': 'vertical' as const,
      'onPointerDown': (press: React.PointerEvent<HTMLDivElement>) => {
        press.preventDefault();
        press.currentTarget.setPointerCapture(press.pointerId);
        setDraggingRail(side);
      },
      'onPointerMove': (move: React.PointerEvent<HTMLDivElement>) => resizeRail(side, move),
      'onPointerUp': (release: React.PointerEvent<HTMLDivElement>) => finishResize(side, release),
      'onPointerCancel': (release: React.PointerEvent<HTMLDivElement>) => finishResize(side, release),
    };
  }

  return (
    <section
      className={`mc-mission${leftOpen ? '' : ' mc-left-closed'}${rightOpen && !snapshotMode ? '' : ' mc-right-closed'}${snapshotMode ? ' mc-snapshot' : ''}`}
      aria-label="Mission control"
      // eslint-disable-next-line no-restricted-syntax -- pointer-driven rail widths are runtime CSS variables.
      style={{
        '--mc-left-width': `${leftWidth}px`,
        '--mc-right-width': `${rightWidth}px`,
      } as React.CSSProperties}
    >
      <MissionRail
        open={leftOpen}
        roster={roster}
        agents={props.agents}
        missionRooms={missionRooms}
        livePeople={panel.live}
        quietPeople={panel.quiet}
        archivedPeople={panel.archived}
        peopleStale={peopleStale}
        selectedId={selectedId}
        onToggle={() => toggleRail('left')}
        onSelectConversation={selectConversation}
        onSelectPerson={selectPerson}
      />

      {leftOpen && (
        <div className="mc-resize-handle mc-resize-left" {...railHandleProps('left')} />
      )}

      <main className="mc-mission-main">
        {snapshotMode ? (
          <>
            <MissionRoomHero snapshot={missionSnapshot.snapshot} />
            <MissionRoom snapshot={missionSnapshot.snapshot} error={missionSnapshot.error} />
          </>
        ) : (
          <>
            <MissionLiveHero
              thread={props.thread}
              title={title}
              facts={missionFacts}
              confidence={props.confidence ?? null}
            />

            {/* MissionStageStrip hidden by ruling M4/D6 (2026-07-23): it
                rendered hardcoded local state, and the non-snapshot surface
                has no real mission-task input to derive it from yet. The
                component remains exported for the future derivation. */}
            <section className="mc-panel mc-activity">
              <header>
                <div>
                  <span className="mc-kicker">Shared conversation</span>
                  <h2>{selected?.title ?? 'Select a conversation'}</h2>
                </div>
                {running > 0 && <span className="mc-live"><i /> Live</span>}
              </header>
              {selected ? (
                <>
                  <Transcript
                    conversation={selected}
                    messages={messagesFor(feed, selected.id)}
                    liveNames={liveNames}
                    targets={targets}
                    onResolve={(itemId) => setDismissed((current) => new Set(current).add(itemId))}
                    onSeen={(createdAt) => advanceCursor(selected.id, createdAt)}
                  />
                  <MessengerComposer conversation={selected} onSend={send} />
                </>
              ) : (
                <p className="mc-empty">Choose a mission room or direct message.</p>
              )}
            </section>

            <MissionHealthBar health={health} />
          </>
        )}
      </main>

      {rightOpen && !snapshotMode && (
        <div className="mc-resize-handle mc-resize-right" {...railHandleProps('right')} />
      )}

      {!snapshotMode && (
        <MissionEvidence
          open={rightOpen}
          squad={squad}
          running={running}
          selectedAgentId={props.selectedAgentId}
          approval={approval}
          onToggle={() => toggleRail('right')}
          onSelectPerson={selectPerson}
          onReviewAttention={props.onReviewAttention}
        />
      )}
    </section>
  );
}
