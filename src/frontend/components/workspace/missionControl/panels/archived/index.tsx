// Mission Control archive disclosure (ruling S1): fetched on open — rooms
// (archived / closed mission) from the endpoint plus client-known retired
// people. Split from panels/index.tsx; presentation only.
import React, { useState } from 'react';
import type { ArchivedLane } from '../../../../../../shared/people/schema.js';
import type { Conversation, ConversationId } from '../../../../../lib/messagingV2/index.js';
import { mergeArchive, type PanelPersonRow } from '../../../../../lib/tunnelModel/panel/index.js';
import { useArchive } from '../../../../../lib/tunnelModel/people/index.js';
import './index.css';

/** Archive disclosure (S1): fetched on open — rooms (archived / closed
 * mission) from the endpoint plus client-known retired people. */
export function ArchivedSection(props: {
  archivedPeople: PanelPersonRow[];
  selectedId: ConversationId | null;
  onSelectConversation(conversation: Conversation): void;
}) {
  const [open, setOpen] = useState(false);
  const archive = useArchive(open);
  const lanes = mergeArchive(archive.lanes, props.archivedPeople);
  const label = open && archive.loaded ? ` · ${lanes.length}` : props.archivedPeople.length > 0 ? ` · ${props.archivedPeople.length}+` : '';
  return (
    <details className="mc-archived" onToggle={(toggle) => setOpen((toggle.target as HTMLDetailsElement).open)}>
      <summary className="mc-section-label mc-archived-summary">Archived{label}</summary>
      <div className="mc-rail-agents">
        {archive.failed && <div className="mc-rail-stale">Archive unavailable right now.</div>}
        {open && archive.loaded && !archive.failed && lanes.length === 0 && (
          <div className="mc-rail-stale">Nothing archived.</div>
        )}
        {lanes.map((lane) => (
          <ArchivedLaneRow
            key={lane.id}
            lane={lane}
            selected={lane.conversationId === props.selectedId}
            onSelect={props.onSelectConversation}
          />
        ))}
      </div>
    </details>
  );
}

function ArchivedLaneRow(props: {
  lane: ArchivedLane;
  selected: boolean;
  onSelect(conversation: Conversation): void;
}) {
  const { lane } = props;
  const target: Conversation = lane.kind === 'room'
    ? { id: lane.conversationId, kind: 'room', title: lane.title }
    : { id: lane.conversationId, kind: 'dm', title: lane.title };
  const reason = lane.reason === 'room-archived' ? 'archived'
    : lane.reason === 'mission-closed' ? `mission closed${lane.missionId ? ` · ${lane.missionId}` : ''}` : 'retired';
  return (
    <button
      type="button"
      className={props.selected ? 'mc-agent mc-agent-selected' : 'mc-agent'}
      onClick={() => props.onSelect(target)}
    >
      <span className="mc-avatar">{lane.kind === 'room' ? '#' : lane.title.charAt(0).toUpperCase()}</span>
      <span className="mc-agent-copy">
        <strong>{lane.title}</strong>
        <small>{reason}</small>
      </span>
      <span className="mc-status" />
    </button>
  );
}
