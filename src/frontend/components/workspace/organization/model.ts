// Organization lens read model — pure derivations from the live seams:
// node layout over the agent roster, wires folded from real DM traffic,
// fleet stats from the tunnel feed, and the /api/usage sweep hook.
import { useEffect, useState } from 'react';
import type { AgentInfo } from '../../../lib/agentSocket/index.js';
import { CHRIS, TEAM_CHANNEL, isRoomLane, type TunnelEnvelope } from '../../../lib/messagingV2/index.js';
import { costOf, fetchUsage, tokensOf, type CostSettings, type SessionUsage } from '../../../lib/cost/index.js';
import type { ProviderId } from '../../../../shared/project/schema.js';

const PROVIDER_SUBTITLE: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };

export interface OrgNode {
  id: string;           // agentId, or 'chris' — unique even when titles collide
  name: string;         // tunnel name: agent title, or 'chris'
  subtitle: string;
  kind: 'human' | 'agent';
  live: boolean;
  agent?: AgentInfo;
  xPct: number;         // percentage coordinates; node centers, SVG endpoints
  yPct: number;
}

export interface OrgWire {
  nameA: string;
  nameB: string;
  count: number;
}

export interface FleetStats {
  directMessages: TunnelEnvelope[];
  failed: TunnelEnvelope[];
  interrupts: number;
  deliveryRate: number;
  latestFailed: TunnelEnvelope | null;
  latestTeamPost: TunnelEnvelope | null;
}

/** Avatar initials — first glyph of the first two words ("Org Lens" → OL). */
export function initials(name: string): string {
  const words = name.split(/[\s·]+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join('');
}

function agentNode(agent: AgentInfo, xPct: number, yPct: number): OrgNode {
  return {
    id: agent.agentId,
    name: agent.title,
    subtitle: PROVIDER_SUBTITLE[agent.provider],
    kind: 'agent',
    live: agent.status === 'running',
    agent,
    xPct,
    yPct,
  };
}

/** Chris at the root; the RUNNING fleet fanned below in tiers of three (four
 * when the fleet is large). Exited sessions stay off the map — the header
 * counts them — so the picture is the organization that exists right now. */
export function layoutNodes(agents: AgentInfo[]): OrgNode[] {
  const running = agents
    .filter((agent) => agent.status === 'running')
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  const perTier = running.length > 12 ? 4 : 3;
  const tiers: AgentInfo[][] = [];
  for (let index = 0; index < running.length; index += perTier) {
    tiers.push(running.slice(index, index + perTier));
  }
  const spanTop = 34;
  const spanBottom = 88;
  return [
    { id: CHRIS, name: CHRIS, subtitle: 'Product owner', kind: 'human', live: true, xPct: 50, yPct: 11 },
    ...tiers.flatMap((tier, tierIndex) => tier.map((agent, column) => agentNode(
      agent,
      tier.length === 1 ? 50 : 19 + (62 * column) / (tier.length - 1),
      tiers.length === 1 ? 60 : spanTop + ((spanBottom - spanTop) * tierIndex) / (tiers.length - 1),
    ))),
  ];
}

/** The lane a DM row lands in carries the counterparty — strip the prefix. */
function counterpartyOf(envelope: TunnelEnvelope): string {
  return envelope.to.startsWith('dm:') ? envelope.to.slice(3) : envelope.to;
}

/** DM traffic between known nodes, folded to undirected pair volumes. N4:
 * rows are capability rows — the `to` of a direct row is its dm: lane; the
 * counterparty name is what wires fold on. */
export function deriveWires(feed: TunnelEnvelope[], nodes: OrgNode[]): OrgWire[] {
  const known = new Set(nodes.map((node) => node.name));
  const volume = new Map<string, OrgWire>();
  for (const envelope of feed) {
    if (isRoomLane(envelope.to)) continue;
    const counterparty = counterpartyOf(envelope);
    if (!known.has(envelope.from) || !known.has(counterparty) || envelope.from === counterparty) continue;
    const [nameA, nameB] = [envelope.from, counterparty].sort() as [string, string];
    const pairKey = `${nameA}␟${nameB}`;
    const wire = volume.get(pairKey);
    if (wire) wire.count += 1;
    else volume.set(pairKey, { nameA, nameB, count: 1 });
  }
  return [...volume.values()];
}

export function deriveStats(feed: TunnelEnvelope[]): FleetStats {
  const directMessages = feed.filter((envelope) => !isRoomLane(envelope.to));
  const failed = feed.filter((envelope) => envelope.status === 'failed');
  return {
    directMessages,
    failed,
    interrupts: feed.filter((envelope) => envelope.delivery === 'interrupt').length,
    deliveryRate: feed.length === 0 ? 1 : (feed.length - failed.length) / feed.length,
    latestFailed: failed[failed.length - 1] ?? null,
    latestTeamPost: [...feed].reverse().find((envelope) => envelope.to === TEAM_CHANNEL) ?? null,
  };
}

/** Fleet spend — one /api/usage sweep per minute keeps the column honest
 * without hammering transcript aggregation. */
async function sweepUsage(agents: AgentInfo[]): Promise<Record<string, SessionUsage>> {
  const entries = await Promise.all(agents.map(async (agent) => {
    const usage = await fetchUsage(agent.projectDir, agent.sessionId).catch(() => null);
    return [agent.agentId, usage] as const;
  }));
  const byAgent: Record<string, SessionUsage> = {};
  for (const [agentId, usage] of entries) if (usage) byAgent[agentId] = usage;
  return byAgent;
}

export function useFleetUsage(agents: AgentInfo[]): Record<string, SessionUsage> {
  const [usageByAgent, setUsageByAgent] = useState<Record<string, SessionUsage>>({});
  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      sweepUsage(agents).then((next) => { if (live) setUsageByAgent(next); });
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [agents]);
  return usageByAgent;
}

export function fullUsageTokens(usage: SessionUsage): number {
  return tokensOf(usage.main) + usage.subagents.reduce((total, entry) => total + tokensOf(entry), 0);
}

export function fullUsageCost(usage: SessionUsage, settings: CostSettings): number {
  return costOf(usage.main, settings)
    + usage.subagents.reduce((total, entry) => total + costOf(entry, settings), 0);
}
