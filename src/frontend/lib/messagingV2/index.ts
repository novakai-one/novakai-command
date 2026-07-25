/**
 * messagingV2 frontend data plane (slice N4 — Frontend, D-N4-2): the
 * capability-backed feed for the Messages tab, Mission Control, and the
 * studio attention lenses. Reads ride the server-owned human routes
 * (D-N4-3); live updates ride the per-connection forwarded-frame
 * subscription (D-N4-1) with a persisted resume cursor (localStorage) —
 * ZERO REST polls for feed updates; reconnect replays from the cursor.
 *
 * BEHAVIOR CHANGE (recorded deliberately): rows carry HONEST states only —
 * a committed message is 'delivered' (it IS durable truth), a failed
 * DeliveryUpdated marks its row 'failed', a just-POSTed row not yet echoed
 * is 'queued'. The old feed-derived "Not delivered" heuristic
 * (presenceToneFor) is DEAD: absence of a delivery effect is NOT failure.
 * CONTRACT CONSEQUENCE (recorded): the human may read only their own
 * direct threads + rooms (R3) — agent↔agent DM lanes the old feed showed
 * are not servable and do not appear.
 */

import type { AgentInfo } from '../agentSocket/index.js';

// --- mirrored contract shapes (frontend mirrors, like tunnelModel before) ---

export interface CapabilityMessage {
  id: string;
  threadId: string;
  senderId: string; // personId
  sequence: number;
  priority: 'normal' | 'urgent';
  createdAt: string;
  body: { text: string };
}

export interface CapabilityThread {
  id: string;
  threadKind: 'direct' | 'team' | 'mission';
  direct?: { pair: [string, string] };
  room?: { authority: string; externalId: string };
  /** Server-enriched (the rooms directory's label — '#team', '#<name>'). */
  label?: string;
}

/** The row shape consumers already render (mechanically TunnelEnvelope). */
export interface MessageRow {
  id: string;
  from: string;
  to: string; // the LANE id: '#team' | '#<room label>' | 'dm:<agent name>'
  delivery: 'normal' | 'interrupt';
  body: string;
  threadId?: string;
  createdAt: string;
  status: 'queued' | 'delivered' | 'failed';
}

export interface Conversation {
  id: string;
  kind: 'room' | 'channel' | 'dm';
  title: string;
  threadId?: string;
  /** Room member display names when a lane carries them (free-room archive). */
  members?: string[];
  lastMessageAt?: string;
}

export type PresenceMap = Record<string, 'open' | 'closed'>;

export const CHRIS = 'chris';
export const TEAM_CHANNEL = '#team';
export const HUMAN_PERSON_ID = 'person_user-chris';
const CURSOR_KEY = 'nvk-messaging-v2-cursor';

// --- translator (capability → view) -------------------------------------------

/**
 * personId → display name: the human is chris; agents forward-derive with
 * the authority's personIdForAgentId shape.
 * DERIVATION IS DEBT (same class as the N2 transport's reverse-map): the
 * authority documents the personId mapping as one-directional, and the
 * right fix is an authority-owned personId→name query (later slice) that
 * both the backend transport and this client consume. Until then, the
 * forward derivation is exact for every live roster entry — never a guess.
 */
export function nameForPersonId(personId: string, agents: Pick<AgentInfo, 'agentId' | 'title'>[]): string {
  if (personId === HUMAN_PERSON_ID) return CHRIS;
  const found = agents.find((agent) => `person_${agent.agentId.replaceAll('_', '-')}` === personId);
  return found?.title ?? personId;
}

/** The lane roster (F13, ONE home): the runtime fleet PLUS people-directory
 * names the fleet doesn't know — registered-but-silent agents keep openable
 * lanes. Extras carry an EMPTY agentId: no id is fabricated (a fabricated
 * `person_<name>` could alias a real personId derivation; '' matches
 * nothing, honestly). */
export interface LaneAgent {
  agentId: string;
  title: string;
  provider: AgentInfo['provider'];
  status: AgentInfo['status'];
}

export function laneRosterFor(
  agents: AgentInfo[],
  people: Array<{ name: string; provider: AgentInfo['provider'] }>,
): LaneAgent[] {
  const known = new Set(agents.map((agent) => agent.title));
  const extras = people
    .filter((person) => !known.has(person.name))
    .map((person) => ({ agentId: '', title: person.name, provider: person.provider, status: 'exited' as const }));
  return [...agents, ...extras];
}

/** One thread → its lane id. */
export function laneForThread(thread: CapabilityThread, agents: Pick<AgentInfo, 'agentId' | 'title'>[]): string {
  if (thread.threadKind === 'direct') {
    const other = thread.direct?.pair.find((personId) => personId !== HUMAN_PERSON_ID);
    return `dm:${nameForPersonId(other ?? HUMAN_PERSON_ID, agents)}`;
  }
  return thread.label ?? `#${thread.room?.externalId ?? thread.id}`;
}

/** Message → row: committed IS durable truth → 'delivered' (renders quiet). */
export function translateMessage(
  message: CapabilityMessage,
  threads: Map<string, CapabilityThread>,
  agents: Pick<AgentInfo, 'agentId' | 'title'>[],
): MessageRow {
  const thread = threads.get(message.threadId);
  return {
    id: message.id,
    from: nameForPersonId(message.senderId, agents),
    'to': thread === undefined ? message.threadId : laneForThread(thread, agents),
    delivery: message.priority === 'urgent' ? 'interrupt' : 'normal',
    body: message.body.text,
    threadId: message.threadId,
    createdAt: message.createdAt,
    status: 'delivered',
  };
}

/** Same id replaces in place (the committed echo settles a 'queued' row).
 * Also exported under the old name (upsertEnvelope, tunnelModel grammar). */
export function upsertRow(feed: MessageRow[], incoming: MessageRow): MessageRow[] {
  const index = feed.findIndex((entry) => entry.id === incoming.id);
  if (index === -1) return [...feed, incoming];
  const next = feed.slice();
  next[index] = incoming;
  return next;
}

/** HONESTY TABLE: a failed DeliveryUpdated marks its row — nothing else
 * touches rows (pending/delivered states render quiet by design). */
export function applyDelivery(feed: MessageRow[], delivery: { messageId: string; state: string }): MessageRow[] {
  if (delivery.state !== 'failed') return feed;
  const index = feed.findIndex((entry) => entry.id === delivery.messageId);
  if (index === -1) return feed;
  const next = feed.slice();
  next[index] = { ...next[index]!, status: 'failed' };
  return next;
}

/** At-least-once dedupe: sequences at/below the cursor are dropped. */
export function advanceCursor(lastSeen: number, sequence: number | undefined): number {
  if (sequence === undefined || sequence <= lastSeen) return lastSeen;
  return sequence;
}

// --- cursor persistence --------------------------------------------------------

export function loadCursor(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(CURSOR_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveCursor(sequence: number): void {
  try {
    globalThis.localStorage?.setItem(CURSOR_KEY, `s_${sequence}`);
  } catch {
    // storage unavailable — resume degrades to a refetch, never a crash
  }
}

// --- REST reads (initial load + thread/presence refresh only) -------------------

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchThreads(): Promise<CapabilityThread[] | null> {
  const data = await fetchJson<{ threads?: CapabilityThread[] }>('/api/messaging/v2/user/threads');
  // F16: null = the read FAILED (a load error, never an empty thread list).
  return data === null ? null : data.threads ?? [];
}

export async function fetchThreadMessages(threadId: string): Promise<CapabilityMessage[]> {
  const data = await fetchJson<{ messages?: CapabilityMessage[] }>(
    `/api/messaging/v2/user/messages?threadId=${encodeURIComponent(threadId)}`,
  );
  return data?.messages ?? [];
}

// --- conversations (rail lanes) -------------------------------------------------

/** Latest row per lane — recency for sorting, candidacy for the amber. */
function latestByLane(feed: MessageRow[]): Map<string, MessageRow> {
  const latest = new Map<string, MessageRow>();
  for (const entry of feed) {
    const seen = latest.get(entry.to);
    if (!seen || entry.createdAt >= seen.createdAt) latest.set(entry.to, entry);
  }
  return latest;
}

function byRecency(left: Conversation, right: Conversation): number {
  if (left.lastMessageAt && right.lastMessageAt) return right.lastMessageAt.localeCompare(left.lastMessageAt);
  if (left.lastMessageAt) return -1;
  if (right.lastMessageAt) return 1;
  return left.title.localeCompare(right.title);
}

function laneKind(laneId: string): Conversation['kind'] {
  if (laneId === TEAM_CHANNEL) return 'channel';
  return laneId.startsWith('dm:') ? 'dm' : 'room';
}

/** Lanes from threads (+ roster names with no thread yet, so a silent agent
 * is still openable — sending creates the thread). Room lanes carry
 * `members: [chris]`: D-N3-1 host policy puts the human in EVERY roster —
 * the prune's members rule is the truth, not a courtesy. */
/** One thread → its rail conversation (lane id, kind, honest membership). */
function conversationFor(
  thread: CapabilityThread,
  agents: Pick<AgentInfo, 'agentId' | 'title'>[],
  latest: Map<string, MessageRow>,
): Conversation {
  const laneId = laneForThread(thread, agents);
  return {
    id: laneId, kind: laneKind(laneId), title: laneId.startsWith('dm:') ? laneId.slice(3) : laneId,
    threadId: thread.id, lastMessageAt: latest.get(laneId)?.createdAt,
    ...(laneKind(laneId) !== 'dm' ? { members: [CHRIS] } : {}),
  };
}

export function buildConversations(
  threads: CapabilityThread[],
  feed: MessageRow[],
  agents: Pick<AgentInfo, 'agentId' | 'title' | 'status'>[],
): Conversation[] {
  const latest = latestByLane(feed);
  const lanes = new Map<string, Conversation>();
  for (const thread of threads) {
    const conversation = conversationFor(thread, agents, latest);
    lanes.set(conversation.id, conversation);
  }
  for (const agent of agents) {
    const laneId = `dm:${agent.title}`;
    if (!lanes.has(laneId)) lanes.set(laneId, { id: laneId, kind: 'dm', title: agent.title });
  }
  return [...lanes.values()].sort(byRecency);
}

const CHRIS_MENTION = /\bchris\b/i;

export interface ChrisQuestion {
  envelopeId: string;
  conversationId: string;
  since: string;
}

/** The ONE amber candidate (unchanged grammar, now over honest rows). */
export function latestChrisQuestion(feed: MessageRow[]): ChrisQuestion | null {
  let winner: ChrisQuestion | null = null;
  for (const [id, entry] of latestByLane(feed)) {
    if (entry.from === CHRIS || !CHRIS_MENTION.test(entry.body)) continue;
    if (!winner || entry.createdAt > winner.since) {
      winner = { envelopeId: entry.id, conversationId: id, since: entry.createdAt };
    }
  }
  return winner;
}

/** One lane's transcript, oldest first. */
export function messagesFor(feed: MessageRow[], laneId: string): MessageRow[] {
  return feed
    .filter((entry) => entry.to === laneId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

/** "claude-1 → codex-2" — the tiny mono route label (grammar preserved).
 * F3 (audit): in a dm lane, an INCOMING row (from === the lane name)
 * renders its bare sender — never '<name> → <name>'. */
export function formatRoute(messageRow: MessageRow): string {
  const laneName = messageRow.to.startsWith('dm:') ? messageRow.to.slice(3) : messageRow.to;
  if (messageRow.from === laneName) return messageRow.from;
  return `${messageRow.from} → ${laneName}`;
}

// Single import surface: the compatibility helpers (was tunnelModel).
export * from './compat/index.js';
export { upsertRow as upsertEnvelope };
