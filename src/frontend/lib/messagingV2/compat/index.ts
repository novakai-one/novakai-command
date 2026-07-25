/**
 * messagingV2 view-model compatibility helpers (slice N4): the small pure
 * derivations the old tunnelModel exported that consumers still need,
 * re-derived over the honest capability rows (../index.ts). This module
 * exists so the consumer rewires stay mechanical; ../index.ts re-exports it
 * for a single import surface. Nothing here invents state.
 */

import { onConnectionChanged } from '../../agentSocket/index.js';
import type { AgentInfo } from '../../agentSocket/index.js';
import { CHRIS, TEAM_CHANNEL } from '../index.js';
import type { Conversation, MessageRow } from '../index.js';

/** Compatibility alias: the old envelope shape, now honest rows. */
export type TunnelEnvelope = MessageRow;
export type ConversationId = string;

export function dmId(agentName: string): ConversationId {
  return `dm:${agentName}`;
}

/** Legacy free-room id check — archive lanes only (none exist post-N4). */
export function isRoomId(recipient: string): boolean {
  return recipient.startsWith('room_');
}

/** Room-shaped lane in the new model: every '#' target (#team, #<label>). */
export function isRoomLane(laneId: string): boolean {
  return laneId.startsWith('#');
}

/** A person row whose lane isn't derivable yet still OPENS (the overlay). */
export function dmLaneFor(agentName: string): Conversation {
  return { id: dmId(agentName), kind: 'dm', title: agentName };
}

/** The lane to render: the derived one when it exists, else the overlay. */
export function resolveSelectedLane(
  conversations: Conversation[],
  overlay: Conversation | null,
  selectedId: ConversationId | null,
): Conversation | null {
  return conversations.find((lane) => lane.id === selectedId)
    ?? (overlay && overlay.id === selectedId ? overlay : null);
}

/** Every lane a row belongs to — ONE thread, ONE lane in the capability
 * model (the old both-parties fold died with agent↔agent visibility, R3). */
export function conversationIdsFor(envelope: TunnelEnvelope): ConversationId[] {
  return [envelope.to];
}

/** Same id replaces in place; a new id appends (upsertRow, old name). */
export { upsertRow as upsertEnvelope } from '../index.js';

/** History snapshot under any live frames that landed while it was in flight. */
export function mergeFeed(history: TunnelEnvelope[], live: TunnelEnvelope[]): TunnelEnvelope[] {
  const byId = new Map<string, TunnelEnvelope>();
  for (const entry of [...history, ...live]) byId.set(entry.id, entry);
  return [...byId.values()];
}

/** Meta-line delivery state. A failure names who IS reachable — the roster
 * hint — because the fix is almost always a misspelled agent name. */
export function statusMeta(envelope: TunnelEnvelope, liveNames: string[]): string {
  if (envelope.status !== 'failed') return envelope.status;
  return liveNames.length > 0 ? `failed — live: ${liveNames.join(', ')}` : 'failed — no live agents';
}

/** Live roster: running agents only, addressed by their title. */
export interface RosterEntry {
  name: string;
  provider: AgentInfo['provider'];
}

export function liveRoster(agents: Pick<AgentInfo, 'title' | 'provider' | 'status'>[]): RosterEntry[] {
  return agents
    .filter((agent) => agent.status === 'running')
    .map((agent) => ({ name: agent.title, provider: agent.provider }));
}

/** Every REGISTERED agent, any status — empty DM lanes materialize for
 * exited teammates too. */
export function registeredRoster(agents: Pick<AgentInfo, 'title' | 'provider'>[]): Array<{ name: string; provider: AgentInfo['provider'] }> {
  return agents.map((agent) => ({ name: agent.title, provider: agent.provider }));
}

/** The row guard (was isEnvelope). */
export function isEnvelope(payload: unknown): payload is TunnelEnvelope {
  const candidate = payload as TunnelEnvelope | null;
  return typeof candidate?.id === 'string' && typeof candidate.from === 'string'
    && typeof candidate.to === 'string' && typeof candidate.createdAt === 'string';
}

/** C5 (audit S3): the refetch-on-reopen trigger. Ws frames dropped while the
 * socket was down are unrecoverable as frames — every projection riding the
 * socket re-pulls through its own read interface when the connection comes
 * back. Fires on every 'connected' transition, never on closes. */
export function refetchOnReconnect(reload: () => void): () => void {
  return onConnectionChanged((status) => {
    if (status === 'connected') reload();
  });
}
