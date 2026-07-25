// RoomsRail — the storyboard's left third: "All" tab + restored search field
// (M8c) + labeled New room / New DM entry points (M5) + desktop collapse
// toggle in the header; folded,
// the rail is a glyph strip with a reopen button (M2). MISSION ROOMS (hash
// rows, unread badges), DIRECT MESSAGES (avatar, name, role, presence dot).
// TEAMS is hidden by owner decision (no backend "team"). All visuals come
// from tokens.css via --msg-* vars; all derivation from model.ts. Change
// lives there, not here.
import React, { useState } from 'react';
import type { AgentInfo } from '../../../../lib/agentSocket/index.js';
import type {
  Conversation,
  ConversationId,
} from '../../../../lib/messagingV2/index.js';
import type { ArchivedLane } from '../../../../../shared/people/schema.js';
import { mergeArchive, type PanelLanes, type PanelPersonRow } from '../../../../lib/tunnelModel/panel/index.js';
import { useArchive } from '../../../../lib/tunnelModel/people/index.js';
import { ArchivedRow, PersonRow } from './rows/index.js';
import {
  MESSAGING_SETTINGS,
  capRailLanes,
  filterRailLanes,
  roomLabelFor,
  splitRailSections,
  type KnownAgent,
} from '../model.js';
import type { ProviderId } from '../../../../../shared/project/schema.js';
import { NEW_ACTION_STYLE, resolveStyle } from '../styles/index.js';
import { NewAgentPicker, NewDmPicker } from './pickers.js';
import './index.css';

interface RoomsRailProps {
  conversations: Conversation[];
  /** The shared agentId-keyed row set both rails render (Task 2.3). */
  panel: PanelLanes;
  /** Archived room-lane ids (S1): absent from the default rooms section; the
   * lanes stay in `conversations` so selecting one from the disclosure (or
   * search) still resolves. */
  archivedLaneIds: string[];
  /** Newest people read failed — list shown is the last good one (M2). */
  peopleStale: boolean;
  /** Rendered label per lane — collision-suffixed by the model (C2). */
  labels: Map<ConversationId, string>;
  unread: Record<ConversationId, number>;
  selectedId: ConversationId | null;
  agents: AgentInfo[];
  /** Known agents (live + exited + feed-history names) for both pickers. */
  knownAgents: KnownAgent[];
  /** Desktop fold state (M2) — the strip shows only the reopen glyph. */
  collapsed: boolean;
  onToggleCollapse(): void;
  onSelect(conversation: Conversation): void;
  onOpenDm(name: string): void;
  onSpawnAgent(provider: ProviderId, title?: string): Promise<void>;
}

function RoomRow(props: {
  lane: Conversation;
  label: string;
  count: number;
  selected: boolean;
  onSelect(conversation: Conversation): void;
}) {
  const classes = props.selected ? 'msg-room is-selected' : 'msg-room';
  return (
    <button
      type="button"
      className={classes}
      aria-current={props.selected ? 'true' : undefined}
      onClick={() => props.onSelect(props.lane)}
    >
      <span className="msg-hash" aria-hidden="true">#</span>
      <span className="msg-room-name" title={props.label}>{props.label}</span>
      {props.count > 0 && <span className="msg-badge">{props.count}</span>}
    </button>
  );
}

type NewFlow = 'dm' | 'agent';

export function RoomsRail(props: RoomsRailProps) {
  const [flow, setFlow] = useState<NewFlow | null>(null);
  // Archive disclosure (S1): the endpoint is read only once opened.
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Rail search (M8c): one substring query filters both sections through the
  // model derivation — the old rail's search box, restored without the tabs.
  const [query, setQuery] = useState('');
  // Bounded rail (C1, audit S4): search filters the FULL lane set first,
  // then the hard bound applies — show-more pages +50 up to the 150 ceiling,
  // beyond which older lanes are reached via search only.
  const [visibleCount, setVisibleCount] = useState(MESSAGING_SETTINGS.rail.cap);
  const capped = capRailLanes(filterRailLanes(props.conversations, query), visibleCount);
  const sections = splitRailSections(capped.lanes);
  // S1 default view: archived rooms leave the section unless the query names
  // them (search reaches archived lanes, same rule as beyond-the-cap lanes).
  const archivedRoomIds = new Set(props.archivedLaneIds);
  const defaultRooms = query.trim()
    ? sections.rooms
    : sections.rooms.filter((lane) => !archivedRoomIds.has(lane.id));
  const atCeiling = visibleCount >= MESSAGING_SETTINGS.rail.ceiling;
  // Person rows (Task 2.4): the shared buckets, windowed by the SAME search
  // + cap chrome as lanes (M1 — chrome windows, never reorders). A row with
  // no derived lane is identity-only (registered, nothing said) and passes
  // the cap — the cap bounds journal-derived lanes, not the directory.
  const needle = query.trim().toLowerCase();
  const cappedDmIds = new Set(sections.directs.map((lane) => lane.id));
  const matchesQuery = (personRow: PanelPersonRow): boolean =>
    !needle || (personRow.person?.name ?? personRow.lane?.title ?? '').toLowerCase().includes(needle);
  const inWindow = (personRow: PanelPersonRow): boolean =>
    matchesQuery(personRow) && (personRow.lane === null || cappedDmIds.has(personRow.lane.id));
  const liveRows = props.panel.live.filter(inWindow);
  const quietRows = props.panel.quiet.filter(inWindow);
  const archivedRows = props.panel.archived.filter(matchesQuery);
  const archive = useArchive(archivedOpen);
  const archivedLanes = mergeArchive(archive.lanes, archivedRows)
    .filter((lane) => !needle || lane.title.toLowerCase().includes(needle));

  function toggleFlow(next: NewFlow): void {
    setFlow((current) => (current === next ? null : next));
  }

  return (
    <aside className="msg-rail" aria-label="Conversations">
      <button
        type="button"
        className="msg-ghost msg-rail-reopen"
        aria-label="Show conversations"
        title="Show conversations"
        aria-expanded={!props.collapsed}
        onClick={props.onToggleCollapse}
      >
        <span className="msg-ghost-glyph msg-glyph-rail" aria-hidden="true" />
      </button>
      <div className="msg-rail-inner">
        <div className="msg-tabbar">
          <div className="msg-tabrow">
            <button type="button" className="msg-tab is-active">All</button>
          </div>
          <div className="msg-tabactions">
            <button
              type="button"
              className="msg-ghost"
              aria-label="Hide conversations"
              title="Hide conversations"
              aria-expanded={!props.collapsed}
              onClick={props.onToggleCollapse}
            >
              <span className="msg-ghost-glyph msg-glyph-rail" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="msg-rail-body">
          <input
            type="search"
            className="msg-rail-search"
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={query}
            onChange={(change) => setQuery(change.target.value)}
          />
          <div className="msg-new-actions">
            <button
              type="button"
              className={resolveStyle(NEW_ACTION_STYLE.base, flow === 'dm' && NEW_ACTION_STYLE.active)}
              aria-expanded={flow === 'dm'}
              onClick={() => toggleFlow('dm')}
            >
              New DM
            </button>
            <button
              type="button"
              className={resolveStyle(NEW_ACTION_STYLE.base, flow === 'agent' && NEW_ACTION_STYLE.active)}
              aria-expanded={flow === 'agent'}
              onClick={() => toggleFlow('agent')}
            >
              New agent
            </button>
          </div>
          {flow === 'agent' && (
            <NewAgentPicker onSpawnAgent={props.onSpawnAgent} onClose={() => setFlow(null)} />
          )}
          {flow === 'dm' && (
            <NewDmPicker
              knownAgents={props.knownAgents}
              onOpenDm={props.onOpenDm}
              onClose={() => setFlow(null)}
            />
          )}
          {(!query.trim() || defaultRooms.length > 0) && <div className="msg-section">Mission rooms</div>}
          {defaultRooms.length === 0 && sections.directs.length === 0 && query.trim() !== '' && (
            <div className="msg-rail-quiet">No lanes match “{query.trim()}”.</div>
          )}
          <div className="msg-rail-stack">
            {defaultRooms.map((lane) => (
              <RoomRow
                key={lane.id}
                lane={lane}
                label={props.labels.get(lane.id) ?? roomLabelFor(lane)}
                count={props.unread[lane.id] ?? 0}
                selected={lane.id === props.selectedId}
                onSelect={props.onSelect}
              />
            ))}
          </div>
          {(!query.trim() || liveRows.length + quietRows.length > 0) && <div className="msg-section">Direct messages</div>}
          {props.peopleStale && <div className="msg-rail-quiet">People directory stale — reconnecting…</div>}
          <div className="msg-rail-stack">
            {[...liveRows, ...quietRows].map((personRow) => (
              <PersonRow
                key={personRow.rowId}
                row={personRow}
                label={props.labels.get(personRow.conversationId) ?? personRow.person?.name ?? personRow.lane?.title ?? personRow.conversationId}
                count={props.unread[personRow.conversationId] ?? 0}
                selected={personRow.conversationId === props.selectedId}
                onSelect={props.onSelect}
              />
            ))}
            {liveRows.length + quietRows.length === 0 && !query.trim() && <div className="msg-rail-quiet">No agents yet</div>}
          </div>
          <details className="msg-archived" onToggle={(toggle) => setArchivedOpen((toggle.target as HTMLDetailsElement).open)}>
            <summary className="msg-section msg-archived-summary">
              Archived{archivedOpen && archive.loaded ? ` · ${archivedLanes.length}` : archivedRows.length > 0 ? ` · ${archivedRows.length}+` : ''}
            </summary>
            <div className="msg-rail-stack">
              {archive.failed && <div className="msg-rail-quiet">Archive unavailable right now.</div>}
              {archivedOpen && archive.loaded && archivedLanes.length === 0 && !archive.failed && (
                <div className="msg-rail-quiet">Nothing archived.</div>
              )}
              {archivedLanes.map((lane) => (
                <ArchivedRow
                  key={lane.id}
                  lane={lane}
                  selected={lane.conversationId === props.selectedId}
                  onSelect={props.onSelect}
                />
              ))}
            </div>
          </details>
          {capped.hiddenCount > 0 && !atCeiling && (
            <button
              type="button"
              className="msg-rail-more"
              onClick={() => setVisibleCount((current) => current + MESSAGING_SETTINGS.rail.page)}
            >
              Show more · {capped.hiddenCount}
            </button>
          )}
          {capped.hiddenCount > 0 && atCeiling && (
            <div className="msg-rail-quiet">Search to find older lanes</div>
          )}
        </div>
      </div>
    </aside>
  );
}
