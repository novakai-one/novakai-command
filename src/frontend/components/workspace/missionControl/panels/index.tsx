// Mission Control presentational panels — the left conversation rail (with
// the room composer), the phase strip, the health bar, and the right live
// squad / attention column. State that only a panel reads lives inside the
// panel; everything shared stays on MissionControl.
import React, { useState } from 'react';
import type { CanonicalEvent } from '../../../../../shared/provider/schema.js';
import type { ThreadRecord } from '../../../../../shared/project/schema.js';
import type { AgentInfo } from '../../../../lib/agentSocket/index.js';
import { MISSION_ROOM_CONVERSATION_ID } from '../../../../lib/missionRoom/index.js';
import type {
  Conversation,
  ConversationId,
  RosterEntry,
} from '../../../../lib/messagingV2/index.js';
import type { PanelPersonRow } from '../../../../lib/tunnelModel/panel/index.js';
import { PanelGlyph } from '../../../ui/index.js';
import type { MissionConfidence } from '../index.js';
import type { MissionHealthMeasure } from '../model.js';
import { AgentRow, DirectMessageRow } from './agentRow.js';
import { ArchivedSection } from './archived/index.js';
import './index.css';

const ROOM_LIMIT = 5;
const PHASES = ['Understand', 'Design', 'Build', 'Verify'] as const;

interface MissionRailProps {
  open: boolean;
  roster: RosterEntry[];
  agents: AgentInfo[];
  missionRooms: Conversation[];
  /** The shared agentId-keyed buckets (Task 2.3) — same data as Messages. */
  livePeople: PanelPersonRow[];
  quietPeople: PanelPersonRow[];
  archivedPeople: PanelPersonRow[];
  /** Newest people read failed — list shown is the last good one (M2). */
  peopleStale: boolean;
  selectedId: ConversationId | null;
  onToggle(): void;
  onSelectConversation(conversation: Conversation): void;
  onSelectPerson(agent: AgentInfo): void;
}

export function MissionRail(props: MissionRailProps) {
  const [roomsExpanded, setRoomsExpanded] = useState(false);
  const visibleRooms = roomsExpanded ? props.missionRooms : props.missionRooms.slice(0, ROOM_LIMIT);

  if (!props.open) {
    return (
      <aside className="mc-mission-rail">
        <button type="button" className="mc-rail-reopen" onClick={props.onToggle} aria-label="Open mission rail" title="Open mission rail">
          <PanelGlyph open={false} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="mc-mission-rail">
      <div className="mc-rail-brand">
        <div className="mc-brand">
          <span className="studio-glyph">&gt;_</span>
          <b>novakai<span>&nbsp;command</span></b>
        </div>
        <button type="button" className="mc-rail-toggle" onClick={props.onToggle} aria-label="Collapse mission rail" title="Collapse mission rail">
          <PanelGlyph open />
        </button>
      </div>

      <div className="mc-section-label mc-section-heading">
        <button
          type="button"
          className="mc-section-toggle"
          onClick={() => setRoomsExpanded((expanded) => !expanded)}
          aria-expanded={roomsExpanded}
        >
          <span>Mission rooms</span>
          <span>{roomsExpanded ? '−' : `+${Math.max(0, props.missionRooms.length - ROOM_LIMIT)}`}</span>
        </button>
      </div>
      <div className="mc-room-list">
        {visibleRooms.map((conversation) => (
          <button
            type="button"
            key={conversation.id}
            className={`${conversation.id === MISSION_ROOM_CONVERSATION_ID ? 'mc-room-pinned ' : ''}${conversation.id === props.selectedId ? 'mc-room mc-room-active' : 'mc-room'}`}
            onClick={() => props.onSelectConversation(conversation)}
          >
            <span>{conversation.id === MISSION_ROOM_CONVERSATION_ID ? '◆' : '#'}</span>
            <strong>{conversation.title}</strong>
            <small>{conversation.id === MISSION_ROOM_CONVERSATION_ID ? 'Mission Room · snapshot' : conversation.lastMessageAt ? 'Recent activity' : 'No messages yet'}</small>
          </button>
        ))}
      </div>

      <div className="mc-section-label mc-section-spaced">Direct messages</div>
      {props.peopleStale && <div className="mc-rail-stale">People directory stale — reconnecting…</div>}
      <div className="mc-rail-agents">
        {[...props.livePeople, ...props.quietPeople].map((personRow) => (
          <DirectMessageRow
            key={personRow.rowId}
            personRow={personRow}
            selected={personRow.conversationId === props.selectedId}
            onSelect={() => selectRow(personRow, props)}
          />
        ))}
      </div>
      <ArchivedSection
        archivedPeople={props.archivedPeople}
        selectedId={props.selectedId}
        onSelectConversation={props.onSelectConversation}
      />
    </aside>
  );
}

/** Row click: runtime-backed people route through onSelectPerson (thread/agent
 * wiring); durable-only or history-only rows open the lane directly — the
 * lane id is transport, so a missing derived lane still opens an overlay. */
function selectRow(personRow: PanelPersonRow, props: MissionRailProps): void {
  const agent = personRow.person ? props.agents.find((candidate) => candidate.agentId === personRow.person?.agentId) : undefined;
  if (agent) return props.onSelectPerson(agent);
  const lane = personRow.lane ?? { id: personRow.conversationId, kind: 'dm' as const, title: personRow.person?.name ?? personRow.conversationId };
  props.onSelectConversation(lane);
}

/** Live-mode hero (non-snapshot): thread kicker, title, facts, confidence. */
export function MissionLiveHero(props: { thread: ThreadRecord | null; title: string; facts: string; confidence?: MissionConfidence | null }) {
  return (
    <header className="mc-mission-hero">
      <div className="mc-mission-outcome">
        <span className="mc-kicker">{props.thread ? 'Active mission' : 'Mission control'}</span>
        <h1>{props.title}</h1>
        {props.facts && <p>{props.facts}</p>}
      </div>
      {props.confidence && (
        <div className="mc-confidence">
          <strong>{props.confidence.score}</strong>
          <span>{props.confidence.label}</span>
          <small>{props.confidence.evidence}</small>
        </div>
      )}
    </header>
  );
}

export function MissionStageStrip() {
  const [activePhase, setActivePhase] = useState(2);
  return (
    <section className="mc-stage-strip" aria-label="Mission phases">
      {PHASES.map((phase, index) => (
        <button
          type="button"
          className={`mc-stage mc-stage-${index < activePhase ? 'done' : index === activePhase ? 'active' : 'waiting'}`}
          key={phase}
          onClick={() => setActivePhase(index)}
          aria-pressed={index === activePhase}
        >
          <span>{index + 1}</span>
          <strong>{phase}</strong>
          <small>{index < activePhase ? 'Complete' : index === activePhase ? 'In progress' : 'Waiting'}</small>
        </button>
      ))}
    </section>
  );
}

export function MissionHealthBar({ health }: { health: MissionHealthMeasure[] }) {
  if (health.length === 0) return null;
  return (
    <section className="mc-health-bar" aria-label="Mission health">
      <div className="mc-health-heading">
        <span className="mc-kicker">Mission health</span>
        <strong>{health.length}</strong>
        <small>Live measures</small>
      </div>
      {health.map((measure) => (
        <div className={measure.tone === 'attention' ? 'mc-health-item mc-health-attention' : 'mc-health-item'} key={measure.id}>
          <span>{measure.label}</span>
          <strong>{measure.value}</strong>
          <small>{measure.detail}</small>
        </div>
      ))}
    </section>
  );
}

interface MissionEvidenceProps {
  open: boolean;
  squad: AgentInfo[];
  running: number;
  selectedAgentId?: string | null;
  approval: CanonicalEvent | null;
  onToggle(): void;
  onSelectPerson(agent: AgentInfo): void;
  onReviewAttention?(): void;
}

export function MissionEvidence(props: MissionEvidenceProps) {
  if (!props.open) {
    return (
      <aside className="mc-evidence-column">
        <button type="button" className="mc-rail-reopen" onClick={props.onToggle} aria-label="Open live squad rail" title="Open live squad rail">
          <PanelGlyph open={false} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="mc-evidence-column">
      <header className="mc-evidence-head">
        <span className="mc-kicker">Live squad</span>
        <button type="button" className="mc-rail-toggle" onClick={props.onToggle} aria-label="Collapse live squad rail" title="Collapse live squad rail">
          <PanelGlyph open />
        </button>
      </header>
      {props.squad.length > 0 && (
        <section className="mc-squad">
          <header>
            <strong>{props.running} live · {props.squad.length} attached</strong>
          </header>
          {props.squad.map((agent) => (
            <AgentRow
              key={agent.agentId}
              agent={agent}
              selected={agent.agentId === props.selectedAgentId}
              onSelect={() => props.onSelectPerson(agent)}
            />
          ))}
        </section>
      )}

      {props.approval && (
        <section className="mc-attention">
          <span className="mc-kicker">Needs you</span>
          <h3>{props.approval.text}</h3>
          {props.approval.approval?.reason && <p>{props.approval.approval.reason}</p>}
          {props.onReviewAttention && (
            <button type="button" onClick={props.onReviewAttention}>Review decision</button>
          )}
        </section>
      )}
    </aside>
  );
}
