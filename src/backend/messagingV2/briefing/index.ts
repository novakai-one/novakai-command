/**
 * messagingV2 spawn briefing (slice N2): standing instructions typed into a
 * new agent's PTY once its CLI has booted — its name, the live roster, and
 * the authenticated v2 send/read protocol. Identity (WHO you are) is
 * NVK_AGENT_ID; the credential (HOW you authenticate, D-N6-2) is
 * NVK_AGENT_TOKEN — both server-injected into the child env, nvk-msg reads
 * the token automatically, and the briefing NEVER prints either value and
 * never mentions --from / NVK_AGENT / curl-ing /api/messages (all deleted
 * with the old agent-originated surface). One PTY submission — no raw
 * newlines (the TUI submits at each one).
 */

export interface BriefingPeer {
  name: string;
  provider: string;
}

export interface BriefingContext {
  /** The agent's own display name (its terminal title). */
  name: string;
  /** Live peers, excluding the briefed agent. */
  peers: BriefingPeer[];
  /** False for plain spawns (no durable record → the authority rejects them). */
  messagingAvailable: boolean;
}

const MESSAGING_LINES = [
  'DM a peer: node scripts/nvk-msg.mjs send --to <peer> "body" — nvk-msg authenticates with the NVK_AGENT_TOKEN env var (already set for you; NVK_AGENT_ID is your identity, never a credential).',
  'Add --interrupt ONLY for real urgency (never to a room).',
  'Read a DM thread: node scripts/nvk-msg.mjs read <name>.',
  "#team is shared fleet-wide history every member can read — post with send --to '#team' \"body\" (mission room: send --to '#mission' \"body\"); push delivery reaches your team/mission co-members + chris, and cross-team members terminally fail delivery by design (DEC-14 deny-by-default stays the gate).",
  "Read the fleet and mission rooms: node scripts/nvk-msg.mjs read '#team' and read '#mission'.",
  'Incoming mail arrives in your prompt prefixed [nvk-msg from <name> id <msgId>] (a DM) or [nvk-room <label> from <name> id <msgId>] (a room post) — reply by sending a message back, not by answering inline.',
];

const UNAVAILABLE_LINE =
  'Direct messaging is unavailable for non-mission agents (no durable record) — do not use nvk-msg.';

export function composeAgentBriefing(context: BriefingContext): string {
  const roster = context.peers.length
    ? context.peers.map((peer) => `${peer.name} (${peer.provider})`).join(', ')
    : 'none yet';
  const lines = [
    `[nvk-msg briefing] You are agent "${context.name}" in Novakai Command.`,
    `Live peers: ${roster}.`,
    ...(context.messagingAvailable ? MESSAGING_LINES : [UNAVAILABLE_LINE]),
  ];
  return lines.join(' ');
}
