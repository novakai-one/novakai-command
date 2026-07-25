/**
 * messagingV2 spawn briefing (slice N2): standing instructions typed into a
 * new agent's PTY once its CLI has booted — its name, the live roster, and
 * the authenticated v2 send/read protocol. Identity is server-injected
 * (NVK_AGENT_ID in the child env); the briefing NEVER prints the token and
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
  'DM a peer: node scripts/nvk-msg.mjs send --to <peer> "body" — your identity comes from the NVK_AGENT_ID env var (already set for you).',
  'Add --interrupt ONLY for real urgency (never to a room).',
  'Read a DM thread: node scripts/nvk-msg.mjs read <name>.',
  "Post to the whole fleet: node scripts/nvk-msg.mjs send --to '#team' \"body\"; post to your mission room: send --to '#mission' \"body\".",
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
