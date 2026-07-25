// Organization lens — variant B's org-compiler center + intelligence column
// rebuilt over the LIVE fleet. Chris sits at the root; every running session
// is a positioned node; the wires are real DM traffic from the capability feed
// (thickness = volume). The right column reads the organization honestly:
// a derived org score, live measures (presence, traffic, spend from
// /api/usage), and the newest thing that deserves attention. Calm grammar:
// framed zones on the studio ramp, sage = alive, no gold — the amber engine
// owns gold everywhere in the app.
import React, { useMemo, useState } from 'react';
import type { AgentInfo } from '../../../lib/agentSocket/index.js';
import { CHRIS } from '../../../lib/messagingV2/index.js';
import { useMessagingFeed } from '../../../lib/messagingV2/feed/index.js';
import {
  formatCost,
  formatTokens,
  loadCostSettings,
  type CostSettings,
  type SessionUsage,
} from '../../../lib/cost/index.js';
import {
  deriveStats,
  deriveWires,
  fullUsageCost,
  fullUsageTokens,
  initials,
  layoutNodes,
  useFleetUsage,
  type FleetStats,
  type OrgNode,
  type OrgWire,
} from './model.js';
import './index.css';

function StatusDot({ live }: { live: boolean }) {
  return <span className={live ? 'org-dot org-live' : 'org-dot'} aria-label={live ? 'live' : 'offline'} />;
}

/** Percent positioning without an inline style attribute (standards gate). */
function placeNode(node: OrgNode): (element: HTMLButtonElement | null) => void {
  return (element) => {
    element?.style.setProperty('left', `${node.xPct}%`);
    element?.style.setProperty('top', `${node.yPct}%`);
  };
}

function OrgMap({ nodes, wires, selectedId, onSelect }: {
  nodes: OrgNode[];
  wires: OrgWire[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  return (
    <div className="org-map">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {wires.map((wire) => {
          const source = nodes.find((node) => node.name === wire.nameA);
          const target = nodes.find((node) => node.name === wire.nameB);
          if (!source || !target) return null;
          return (
            <line
              key={`${wire.nameA}-${wire.nameB}`}
              x1={source.xPct} y1={source.yPct} x2={target.xPct} y2={target.yPct}
              className={wire.count > 6 ? 'org-wire org-wire-busy' : 'org-wire'}
            />
          );
        })}
      </svg>
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-org-node={node.id}
          ref={placeNode(node)}
          className={
            `org-node${node.kind === 'human' ? ' org-node-root' : ''}`
            + `${selectedId === node.id ? ' org-selected' : ''}`
          }
          onClick={() => onSelect(node.id)}
        >
          <span className="org-avatar">{initials(node.name === CHRIS ? 'Chris' : node.name)}</span>
          <strong>{node.name === CHRIS ? 'Chris' : node.name}</strong>
          <small>{node.subtitle}</small>
          <em><StatusDot live={node.live} />{node.kind === 'human' ? 'here' : 'running'}</em>
        </button>
      ))}
      {nodes.length <= 1 && <p className="org-empty">No agents in the fleet yet.</p>}
    </div>
  );
}

function SelectedBar({ selected, usage, traffic, settings }: {
  selected: OrgNode | null;
  usage: SessionUsage | null;
  traffic: number;
  settings: CostSettings;
}) {
  if (!selected) {
    return (
      <footer className="org-selected-bar">
        <p className="org-selected-hint">Select a node to inspect its session.</p>
      </footer>
    );
  }
  const spend = usage
    ? `${formatTokens(fullUsageTokens(usage))} tokens · ${formatCost(fullUsageCost(usage, settings), settings.currency)}`
    : selected.kind === 'human' ? 'Priceless' : 'No transcript yet';
  return (
    <footer className="org-selected-bar">
      <div>
        <span className="org-kicker">Selected</span>
        <h3>{selected.name === CHRIS ? 'Chris' : selected.name}</h3>
        <p>
          {selected.kind === 'human'
            ? 'Product owner · every wire above ends here'
            : `${selected.subtitle} session · ${selected.live ? 'running' : 'exited'} · ${traffic} direct message${traffic === 1 ? '' : 's'}`}
        </p>
      </div>
      <div>
        <span className="org-kicker">Session spend</span>
        <strong>{spend}</strong>
      </div>
    </footer>
  );
}

function IntelColumn({ agents, liveCount, stats, orgScore, roomCount, fleetTokens, fleetCost, settings, feedSize }: {
  agents: AgentInfo[];
  liveCount: number;
  stats: FleetStats;
  orgScore: number;
  roomCount: number;
  fleetTokens: number;
  fleetCost: number;
  settings: CostSettings;
  feedSize: number;
}) {
  return (
    <aside className="org-intel">
      <section className="org-panel org-score">
        <span className="org-kicker">Organization health</span>
        <strong>{agents.length === 0 ? '—' : orgScore}</strong>
        <p>
          {liveCount} of {agents.length} sessions live · {Math.round(stats.deliveryRate * 100)}% of
          {' '}{feedSize} messages delivered.
        </p>
      </section>
      <section className="org-panel org-measures">
        <header>
          <span className="org-kicker">Fleet measures</span>
          <strong>Novakai Command</strong>
        </header>
        <div className="org-measure">
          <div><span>Presence</span><small>running sessions right now</small></div>
          <strong>{liveCount} / {agents.length}</strong>
        </div>
        <div className="org-measure">
          <div><span>Direct traffic</span><small>{stats.interrupts} interrupts sent</small></div>
          <strong>{stats.directMessages.length}</strong>
        </div>
        <div className="org-measure">
          <div>
            <span>Failed sends</span>
            <small>{stats.latestFailed ? `${stats.latestFailed.from} → ${stats.latestFailed.to}` : 'all landing'}</small>
          </div>
          <strong>{stats.failed.length}</strong>
        </div>
        <div className="org-measure">
          <div><span>Fleet spend</span><small>{formatTokens(fleetTokens)} tokens across sessions</small></div>
          <strong>{formatCost(fleetCost, settings.currency)}</strong>
        </div>
        <div className="org-measure">
          <div><span>Rooms</span><small>group lanes in messaging</small></div>
          <strong>{roomCount}</strong>
        </div>
      </section>
      <section className="org-panel org-attention">
        <span className="org-kicker">{stats.latestFailed ? 'Needs a look' : 'Latest on #team'}</span>
        {stats.latestFailed ? (
          <>
            <h3>{stats.latestFailed.from} → {stats.latestFailed.to} failed</h3>
            <p>The newest undelivered message in the fleet — usually a misspelled agent name.</p>
          </>
        ) : stats.latestTeamPost ? (
          <>
            <h3>{stats.latestTeamPost.from}</h3>
            <p>
              {stats.latestTeamPost.body.length > 180
                ? `${stats.latestTeamPost.body.slice(0, 180)}…`
                : stats.latestTeamPost.body}
            </p>
          </>
        ) : (
          <p>The tunnel is quiet.</p>
        )}
      </section>
    </aside>
  );
}

export function OrganizationLens({ agents }: { agents: AgentInfo[] }) {
  const { feed, threads } = useMessagingFeed(agents);
  // Rooms in the capability model: every non-direct thread (fleet + teams + missions).
  const roomCount = threads.filter((thread) => thread.threadKind !== 'direct').length;
  const usageByAgent = useFleetUsage(agents);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const nodes = useMemo(() => layoutNodes(agents), [agents]);
  const wires = useMemo(() => deriveWires(feed, nodes), [feed, nodes]);
  const stats = useMemo(() => deriveStats(feed), [feed]);
  const selected = nodes.find((node) => node.id === selectedId) ?? null;

  const costSettings = useMemo(loadCostSettings, []);
  const liveCount = agents.filter((agent) => agent.status === 'running').length;
  const fleetTokens = Object.values(usageByAgent).reduce((total, usage) => total + fullUsageTokens(usage), 0);
  const fleetCost = Object.values(usageByAgent).reduce(
    (total, usage) => total + fullUsageCost(usage, costSettings), 0);

  // Org score = the two things that make a fleet an organization: sessions
  // alive and messages landing. Both ratios are real, both explainable.
  const liveRate = agents.length === 0 ? 0 : liveCount / agents.length;
  const orgScore = Math.round(100 * (0.5 * liveRate + 0.5 * stats.deliveryRate));

  const selectedUsage = selected?.agent ? usageByAgent[selected.agent.agentId] ?? null : null;
  const selectedTraffic = selected
    ? stats.directMessages.filter((envelope) => envelope.from === selected.name || envelope.to === selected.name).length
    : 0;

  return (
    <div className="org-lens">
      <section className="org-canvas">
        <header className="org-canvas-head">
          <div>
            <span className="org-kicker">Organization</span>
            <h2>Live fleet · {liveCount} running · {agents.length - liveCount} idle sessions</h2>
          </div>
          <div className="org-legend">
            <span><StatusDot live />Live</span>
            <span><i className="org-legend-wire" />Message traffic</span>
          </div>
        </header>
        <OrgMap
          nodes={nodes}
          wires={wires}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
        />
        <SelectedBar selected={selected} usage={selectedUsage} traffic={selectedTraffic} settings={costSettings} />
      </section>
      <IntelColumn
        agents={agents}
        liveCount={liveCount}
        stats={stats}
        orgScore={orgScore}
        roomCount={roomCount}
        fleetTokens={fleetTokens}
        fleetCost={fleetCost}
        settings={costSettings}
        feedSize={feed.length}
      />
    </div>
  );
}
