// ContextPanel — the storyboard's right rail. Room/channel selected →
// Summary view: identity header (name, kind, member count — same pattern as
// the DM person header), Notifications from REAL failed sends (Review
// scrolls the thread to the row and resolves its amber item; when the row
// genuinely can't be located the panel says so), derived Recap notes,
// Current = running members, Tasks = designed empty state (D10);
// Artefacts/Links stay hidden — no data source. DM selected → person
// context with Tasks / Stats (REAL derived counts, never dummy numbers) /
// Settings tabs; tab choice is ephemeral per mount (D7).
import React, { useState } from 'react';
import type { AgentInfo } from '../../../../lib/agentSocket/index.js';
import {
  CHRIS,
  type Conversation,
  type TunnelEnvelope,
} from '../../../../lib/messagingV2/index.js';
import { laneStatsFor, recapNotesFor, roomIdentityFor } from '../model.js';
import './index.css';

type PersonTab = 'tasks' | 'stats' | 'settings';

interface ContextPanelProps {
  conversation: Conversation;
  /** Rendered lane label — collision-suffixed by the model (C2), so the
   *  "where you are" header always matches the rail row Chris clicked. */
  laneLabel: string;
  messages: TunnelEnvelope[];
  agents: AgentInfo[];
  unreadCount: number;
  /** The agent "working" at this lane's live edge (model predicate), else null. */
  working: string | null;
  /** Honest inline note when a Review click cannot locate its row; else null. */
  reviewNote: string | null;
  onReview(envelopeId: string): void;
  onCollapse(): void;
}

const PERSON_TABS: { id: PersonTab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'stats', label: 'Stats' },
  { id: 'settings', label: 'Settings' },
];

function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 64 ? `${flat.slice(0, 64)}…` : flat;
}

function CollapseButton(props: { onCollapse(): void }) {
  return (
    <button
      type="button"
      className="msg-ghost"
      aria-label="Hide context panel"
      title="Hide context panel"
      onClick={props.onCollapse}
    >
      <span className="msg-ghost-glyph msg-glyph-hide-context" aria-hidden="true" />
    </button>
  );
}

/** Designed empty state (D10): one hollow ring + honest two-line label. */
function EmptyPane(props: { title: string; note: string }) {
  return (
    <div className="msg-empty">
      <span className="msg-empty-ring" aria-hidden="true" />
      <p>
        {props.title}
        <small>{props.note}</small>
      </p>
    </div>
  );
}

function SummaryView(props: Omit<ContextPanelProps, 'working'>) {
  const { conversation, messages, agents, unreadCount, reviewNote, onReview, onCollapse } = props;
  const failed = messages.filter((entry) => entry.status === 'failed');
  const running = agents.filter((agent) => agent.status === 'running');
  const members = conversation.members ?? running.map((agent) => agent.title);
  const current = members.filter(
    (name) => name !== CHRIS && running.some((agent) => agent.title === name),
  );
  return (
    <>
      <div className="msg-tabbar">
        <div className="msg-tabrow">
          <button type="button" className="msg-tab is-active">Summary</button>
        </div>
        <CollapseButton onCollapse={onCollapse} />
      </div>
      <div className="msg-context-body">
        <div className="msg-person-head">
          <strong>{props.laneLabel}</strong>
          <span>{roomIdentityFor(conversation)}</span>
        </div>
        <section className="msg-panel">
          <div className="msg-section">Notifications</div>
          {failed.map((entry) => (
            <div className="msg-notice" key={entry.id}>
              <span className="msg-notice-title">{excerptOf(entry.body)}</span>
              <button type="button" className="msg-review" onClick={() => onReview(entry.id)}>
                Review
              </button>
            </div>
          ))}
          {failed.length === 0 && <p className="msg-panel-quiet">No failed deliveries.</p>}
          {reviewNote && <p className="msg-panel-quiet">{reviewNote}</p>}
        </section>
        <section className="msg-panel">
          <div className="msg-section">Recap</div>
          {recapNotesFor(conversation, messages, unreadCount).map((note) => (
            <div className="msg-note" key={note}>
              <span className="msg-note-dot" aria-hidden="true" />
              <p>{note}</p>
            </div>
          ))}
        </section>
        <section className="msg-panel">
          <div className="msg-section">Current</div>
          {current.map((name) => (
            <div className="msg-current" key={name}>
              <span className="msg-marker" aria-hidden="true" />
              <p>{name} is running.</p>
            </div>
          ))}
          {current.length === 0 && <p className="msg-panel-quiet">No members active right now.</p>}
        </section>
        <section className="msg-panel">
          <div className="msg-section">Tasks</div>
          <EmptyPane title="No tasks yet" note="Work given to this room will gather here." />
        </section>
      </div>
    </>
  );
}

function PersonView(props: ContextPanelProps) {
  const { conversation, messages, agents, working, onCollapse } = props;
  const [activeTab, setActiveTab] = useState<PersonTab>('tasks');
  const agent = agents.find((entry) => entry.title === conversation.title);
  const stats = laneStatsFor(messages);
  return (
    <>
      <div className="msg-tabbar">
        <div className="msg-tabrow">
          {PERSON_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={activeTab === entry.id ? 'msg-tab is-active' : 'msg-tab'}
              onClick={() => setActiveTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <CollapseButton onCollapse={onCollapse} />
      </div>
      <div className="msg-context-body">
        <div className="msg-person-head">
          <strong>{props.laneLabel}</strong>
          <span>{agent?.provider ?? 'agent'}</span>
          {working === conversation.title && <em>Working…</em>}
        </div>
        {activeTab === 'tasks' && (
          <section className="msg-panel">
            <div className="msg-section">Tasks</div>
            <EmptyPane
              title="No tasks yet"
              note={`Work given to ${conversation.title} will gather here.`}
            />
          </section>
        )}
        {activeTab === 'stats' && (
          <section className="msg-panel">
            <div className="msg-section">Stats</div>
            <div className="msg-stat"><span>Sent by you</span><strong>{stats.sent}</strong></div>
            <div className="msg-stat"><span>Received</span><strong>{stats.received}</strong></div>
            <div className="msg-stat"><span>Delivered</span><strong>{stats.delivered}</strong></div>
            {stats.queued > 0 && <div className="msg-stat"><span>Sending</span><strong>{stats.queued}</strong></div>}
            <div className="msg-stat"><span>Failed</span><strong>{stats.failed}</strong></div>
          </section>
        )}
        {activeTab === 'settings' && (
          <section className="msg-panel">
            <div className="msg-section">Settings</div>
            <EmptyPane title="Nothing to configure yet" note="Per-agent settings will live here." />
          </section>
        )}
      </div>
    </>
  );
}

export function ContextPanel(props: ContextPanelProps) {
  return (
    <aside className="msg-context" aria-label="Conversation context">
      {props.conversation.kind === 'dm' ? <PersonView {...props} /> : <SummaryView {...props} />}
    </aside>
  );
}
