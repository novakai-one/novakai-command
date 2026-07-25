// New-lane flows (round 3, M5) — the ways a lane comes into being. N4: the
// free-room creation flow is DELETED (rooms are team/mission/fleet threads
// now, D-N4-4 — no POST /api/user/rooms left). A DM needs no server
// resource at all: the lane is derived, so "creating" one is just opening
// it. The overlay below stands in for the not-yet-derived lane until
// Chris's first envelope lands and buildConversations picks it up for real.
import { useState } from 'react';
import type { AgentInfo } from '../../../../lib/agentSocket/index.js';
import type { ProviderId } from '../../../../../shared/project/schema.js';
import {
  type Conversation,
  type ConversationId,
} from '../../../../lib/messagingV2/index.js';
import { dmLaneFor, resolveSelectedLane } from '../model.js';

/** POST JSON and unwrap the error body into an honest Error message
 *  (server `error` field + live-roster hint when one came back). */
export async function postJson(path: string, payload: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string; roster?: string[] } | null;
    const rosterHint = failure?.roster?.length ? ` (live: ${failure.roster.join(', ')})` : '';
    throw new Error(`${failure?.error ?? `HTTP ${response.status}`}${rosterHint}`);
  }
  return response.json();
}

interface LaneFlowDeps {
  openLane(id: ConversationId): void;
}

/** Spawn-from-Messages (C4, audit S1): the same POST /api/agents path the
 *  Agents pane uses; the server mints a unique title when none is given.
 *  The caller creates the DM overlay BEFORE selecting, so the lane renders
 *  from this 201 ALONE — no dependency on the agents-changed roster frame,
 *  which races the response. When the frame lands, resolveSelectedLane
 *  reconciles to the derived lane exactly as openDm's overlay does. */
async function spawnAgentRequest(provider: ProviderId, title?: string): Promise<AgentInfo> {
  return (await postJson('/api/agents', title ? { provider, title } : { provider })) as AgentInfo;
}

/** The flow logic behind useLaneFlows, React-free so tests can drive the
 *  REAL composition (fetch seam included) — the hook only binds state. */
export interface LaneFlowIo extends LaneFlowDeps {
  setOverlay(lane: Conversation | null): void;
}

export function createLaneFlows(laneIo: LaneFlowIo): {
  openDm(name: string): Conversation;
  spawnAgent(provider: ProviderId, title?: string): Promise<void>;
} {
  function openDm(name: string): Conversation {
    const lane = dmLaneFor(name);
    laneIo.setOverlay(lane); return lane;
  }
  async function spawnAgent(provider: ProviderId, title?: string): Promise<void> {
    const lane = dmLaneFor((await spawnAgentRequest(provider, title)).title);
    laneIo.setOverlay(lane); // BEFORE selecting: the lane renders from the 201 alone (S1)
    laneIo.openLane(lane.id);
  }
  return { openDm, spawnAgent };
}

/** Lane-creation flows for the rail entry points: openDm derives the DM
 *  lane locally (a DM is not a server resource) and holds it as an overlay
 *  until the first envelope makes buildConversations derive it for real. */
export function useLaneFlows({ openLane }: LaneFlowDeps): {
  resolveSelected(conversations: Conversation[], selectedId: ConversationId | null): Conversation | null;
  openDm(name: string): Conversation;
  spawnAgent(provider: ProviderId, title?: string): Promise<void>;
} {
  const [overlay, setOverlay] = useState<Conversation | null>(null);
  const flows = createLaneFlows({ openLane, setOverlay });
  function resolveSelected(conversations: Conversation[], selectedId: ConversationId | null): Conversation | null {
    return resolveSelectedLane(conversations, overlay, selectedId);
  }
  return { resolveSelected, ...flows };
}
