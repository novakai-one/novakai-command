// Tunnel feed read model. Agent↔agent envelopes (DMs + #team posts) rendered
// in the anti-prose grammar: tiny mono route label, body, delivery state in
// the meta line. History comes from GET /api/messages; live envelopes ride
// the shared ws as { event: 'message-envelope', payload } frames. Status
// amendments reuse the envelope id — the feed folds by id, later wins.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connect,
  connectionStatus,
  onConnectionChanged,
  onMessageEnvelope,
  onRoomsChanged,
  type AgentInfo,
  type ConnectionStatus,
} from '../agentSocket/index.js';

/** Frontend mirror of src/backend/messaging/types.ts MessageEnvelope. */
export interface TunnelEnvelope {
  id: string;
  from: string;
  to: string;
  delivery: 'normal' | 'interrupt';
  body: string;
  threadId?: string;
  createdAt: string;
  // 'accepted' = bytes written, effect not yet transcript-proven (D1).
  status: 'queued' | 'accepted' | 'delivered' | 'partial' | 'failed';
}

/** Same id replaces in place (status amendment); a new id appends. */
export function upsertEnvelope(feed: TunnelEnvelope[], envelope: TunnelEnvelope): TunnelEnvelope[] {
  const index = feed.findIndex((entry) => entry.id === envelope.id);
  if (index === -1) return [...feed, envelope];
  const next = feed.slice();
  next[index] = envelope;
  return next;
}

/** History snapshot under any live frames that landed while it was in flight. */
export function mergeFeed(history: TunnelEnvelope[], live: TunnelEnvelope[]): TunnelEnvelope[] {
  return live.reduce(upsertEnvelope, history);
}

/** "claude-1 → codex-2" / "claude-1 → #team" — the tiny mono route label. */
export function formatRoute(envelope: TunnelEnvelope): string {
  return `${envelope.from} → ${envelope.to}`;
}

/** Meta-line delivery state. A failure names who IS reachable — the roster
 * hint — because the fix is almost always a misspelled agent name. */
export function statusMeta(envelope: TunnelEnvelope, liveNames: string[]): string {
  if (envelope.status !== 'failed') return envelope.status;
  return liveNames.length > 0 ? `failed — live: ${liveNames.join(', ')}` : 'failed — no live agents';
}

/** Reserved member name: Chris has no PTY — the studio ws push is his copy. */
export const CHRIS = 'chris';
export const TEAM_CHANNEL = '#team';

/** Frontend mirror of the Room shape in the tunnel-rooms API contract. */
export interface TunnelRoom {
  roomId: string;          // room_<uuid>
  name: string;
  members: string[];       // agent names + 'chris'
  createdBy: string;
  createdAt: string;
  archived: boolean;
}

export type ConversationId = string; // 'room_<id>' | '#team' | 'dm:<agentName>'

export interface Conversation {
  id: ConversationId;
  kind: 'room' | 'channel' | 'dm';
  title: string;               // room name / '#team' / agent name
  members?: string[];
  lastMessageAt?: string;
}

export function isRoomId(recipient: string): boolean {
  return recipient.startsWith('room_');
}

export function dmId(agentName: string): ConversationId {
  return `dm:${agentName}`;
}

/* ---------- DM lane overlay (shared, mission_visual-truth defect 1) ----------
   A person row whose lane isn't derivable yet (registered-but-silent agent,
   durable-only identity, archived person) still must OPEN on click. The
   overlay stands in until history derives a real lane. Home is the shared
   model so Mission Control and Messages can never diverge again (the original
   noop class: Messages had this, Mission Control didn't). */
export function dmLaneFor(agentName: string): Conversation {
  return { id: dmId(agentName), kind: 'dm', title: agentName };
}

/** The lane to render: the derived one when it exists, else the overlay —
 *  but only while the overlay is what is actually selected (no stale leak). */
export function resolveSelectedLane(
  conversations: Conversation[],
  overlay: Conversation | null,
  selectedId: ConversationId | null,
): Conversation | null {
  return conversations.find((lane) => lane.id === selectedId)
    ?? (overlay && overlay.id === selectedId ? overlay : null);
}

/** Every lane an envelope belongs to. A room post lives in its room, a #team
 * post in the channel; a DM lands in the lane of each non-chris party —
 * sender's lane first — so chris↔agent traffic folds into the agent's single
 * lane and an agent↔agent DM is visible from both agents' lanes. */
export function conversationIdsFor(envelope: TunnelEnvelope): ConversationId[] {
  if (isRoomId(envelope.to)) return [envelope.to];
  if (envelope.to === TEAM_CHANNEL) return [TEAM_CHANNEL];
  const parties = [envelope.from, envelope.to].filter((party) => party !== CHRIS);
  return [...new Set(parties)].map(dmId);
}

/** One lane's transcript, oldest first — lane loads can interleave arrival
 * order, so time (not arrival) owns the reading order. */
export function messagesFor(feed: TunnelEnvelope[], id: ConversationId): TunnelEnvelope[] {
  return feed
    .filter((envelope) => conversationIdsFor(envelope).includes(id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export interface RosterEntry {
  name: string;
  provider: AgentInfo['provider'];
}

export function liveRoster(agents: Pick<AgentInfo, 'title' | 'provider' | 'status'>[]): RosterEntry[] {
  return agents
    .filter((agent) => agent.status === 'running')
    .map((agent) => ({ name: agent.title, provider: agent.provider }));
}

/** Every REGISTERED agent, any status — the Messages rail materializes an
 * empty DM lane for exited teammates too (Chris can open a DM with anyone
 * on the registry; liveRoster would silently drop the exited ones). */
export function registeredRoster(agents: Pick<AgentInfo, 'title' | 'provider'>[]): RosterEntry[] {
  return agents.map((agent) => ({ name: agent.title, provider: agent.provider }));
}

/** Same roomId replaces in place (amended copy); a new room appends. */
export function upsertRoom(rooms: TunnelRoom[], room: TunnelRoom): TunnelRoom[] {
  const index = rooms.findIndex((entry) => entry.roomId === room.roomId);
  if (index === -1) return [...rooms, room];
  const next = rooms.slice();
  next[index] = room;
  return next;
}

/** Newest activity first, quiet lanes at the end (alphabetical there). */
function byRecency(left: Conversation, right: Conversation): number {
  if (left.lastMessageAt && right.lastMessageAt) return right.lastMessageAt.localeCompare(left.lastMessageAt);
  if (left.lastMessageAt) return -1;
  if (right.lastMessageAt) return 1;
  return left.title.localeCompare(right.title);
}

/** Latest envelope per lane — recency for sorting, candidacy for the amber. */
function latestByLane(feed: TunnelEnvelope[]): Map<ConversationId, TunnelEnvelope> {
  const latest = new Map<ConversationId, TunnelEnvelope>();
  for (const envelope of feed) {
    for (const id of conversationIdsFor(envelope)) {
      const seen = latest.get(id);
      if (!seen || envelope.createdAt >= seen.createdAt) latest.set(id, envelope);
    }
  }
  return latest;
}

/** One DM lane per live agent, plus lanes only history knows about — exited
 * agents' words stay reachable. */
function dmLanes(latest: Map<ConversationId, TunnelEnvelope>, roster: RosterEntry[]): string[] {
  const names = new Set(roster.map((entry) => entry.name));
  for (const id of latest.keys()) {
    if (id.startsWith('dm:')) names.add(id.slice(3));
  }
  return [...names];
}

/** The unified chats list: #team + non-archived rooms + DM lanes. */
export function buildConversations(
  feed: TunnelEnvelope[],
  rooms: TunnelRoom[],
  roster: RosterEntry[],
): Conversation[] {
  const latest = latestByLane(feed);
  const lastAt = (id: ConversationId): string | undefined => latest.get(id)?.createdAt;
  const conversations: Conversation[] = [
    { id: TEAM_CHANNEL, kind: 'channel', title: TEAM_CHANNEL, lastMessageAt: lastAt(TEAM_CHANNEL) },
    ...rooms.filter((room) => !room.archived).map((room): Conversation => ({
      id: room.roomId, kind: 'room', title: room.name, members: room.members, lastMessageAt: lastAt(room.roomId),
    })),
    ...dmLanes(latest, roster).map((name): Conversation => ({
      id: dmId(name), kind: 'dm', title: name, lastMessageAt: lastAt(dmId(name)),
    })),
  ];
  return conversations.sort(byRecency);
}

const CHRIS_MENTION = /\bchris\b/i;

export interface ChrisQuestion {
  envelopeId: string;
  conversationId: ConversationId;
  since: string;
}

/** The ONE amber candidate: the most recent conversation whose LATEST message
 * mentions Chris — his name spoken by someone else, still the newest word in
 * that lane. A later message in the lane supersedes it (the need passed); an
 * agent↔agent DM lights only the sender's lane. */
export function latestChrisQuestion(feed: TunnelEnvelope[]): ChrisQuestion | null {
  let winner: ChrisQuestion | null = null;
  for (const [id, envelope] of latestByLane(feed)) {
    if (envelope.from === CHRIS || !CHRIS_MENTION.test(envelope.body)) continue;
    if (conversationIdsFor(envelope)[0] !== id) continue;
    if (!winner || envelope.createdAt > winner.since) {
      winner = { envelopeId: envelope.id, conversationId: id, since: envelope.createdAt };
    }
  }
  return winner;
}

function isEnvelope(payload: unknown): payload is TunnelEnvelope {
  const candidate = payload as TunnelEnvelope | null;
  return typeof candidate?.id === 'string' && typeof candidate.from === 'string'
    && typeof candidate.to === 'string' && typeof candidate.createdAt === 'string';
}

/** Server-side history filter for one lane. N3 (audit F1): #team reads the
 * capability shim — the parameterless pull only ever saw the pre-N3 archive. */
function historyPath(id: ConversationId): string {
  if (isRoomId(id)) return `/api/messages?withRoom=${encodeURIComponent(id)}`;
  if (id.startsWith('dm:')) return `/api/messages?withAgent=${encodeURIComponent(id.slice(3))}`;
  if (id === TEAM_CHANNEL) return `/api/messages?withAgent=${encodeURIComponent(TEAM_CHANNEL)}`;
  return '/api/messages';
}

function fetchMessages(path: string, apply: (messages: TunnelEnvelope[]) => void, onSettled?: () => void): void {
  fetch(path)
    .then((response) => response.json())
    .then((data: { messages?: TunnelEnvelope[] }) => apply(data.messages ?? []))
    .catch(() => {})
    .finally(() => onSettled?.());
}

/** Live tunnel feed: one fetch of history on mount, then ws frames upserted
 * over it. The agentSocket singleton carries the frames; connect() is
 * idempotent so this hook never races the rest of the app. loadConversation
 * (stable identity) pulls one lane's history in under the live frames —
 * selecting a lane in the messenger backfills anything the mount fetch or a
 * dropped socket missed. */
type FeedUpdater = (updater: (current: TunnelEnvelope[]) => TunnelEnvelope[]) => void;

/** C5 (audit S3): the refetch-on-reopen trigger. Ws frames dropped while the
 * socket was down are unrecoverable as frames — every projection riding the
 * socket re-pulls through its own read interface when the connection comes
 * back. Fires on every 'connected' transition (including the first open —
 * a mount fetch that raced a dead backend heals when the ws lands), never
 * on closes or repeated failed retries. Returns the unsubscribe. */
export function refetchOnReconnect(reload: () => void): () => void {
  return onConnectionChanged((status) => {
    if (status === 'connected') reload();
  });
}

function subscribeFeed(setFeed: FeedUpdater, isLive: () => boolean): () => void {
  return onMessageEnvelope((payload) => {
    if (isLive() && isEnvelope(payload)) setFeed((current) => upsertEnvelope(current, payload));
  });
}

/** Exported for the reconnect-wiring test — the hook is its only app caller. */
export function mountFeed(
  setFeed: FeedUpdater,
  mounted: { current: boolean },
  loadConversation: (id: ConversationId) => void,
): () => void {
  mounted.current = true;
  connect();
  loadConversation(TEAM_CHANNEL);

  const unsubscribe = subscribeFeed(setFeed, () => mounted.current);
  const offReload = refetchOnReconnect(() => loadConversation(TEAM_CHANNEL));
  return () => {
    mounted.current = false;
    unsubscribe();
    offReload();
  };
}

export function useTunnelFeed(): {
  feed: TunnelEnvelope[];
  /** True once the initial history fetch has settled (success OR failure) —
   * the D3 restore machine waits on this, never on luck (ruling S7). */
  feedLoaded: boolean;
  /** Live ws status (C5) — the view shows it and re-pulls the selected lane
   * on each return to 'connected'. */
  connection: ConnectionStatus;
  loadConversation: (id: ConversationId) => void;
  /** Folds a settled envelope in without waiting for the ws echo — the POST
   * /api/user/messages 201 carries the final status, so a sender's own row
   * settles even if the amendment frame never reaches this client. */
  ingestEnvelope: (envelope: TunnelEnvelope) => void;
} {
  const [feed, setFeed] = useState<TunnelEnvelope[]>([]);
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>(() => connectionStatus());
  const mounted = useRef(true);
  const loadConversation = useCallback((id: ConversationId): void => {
    fetchMessages(historyPath(id), (messages) => {
      if (mounted.current) setFeed((live) => mergeFeed(messages, live));
    }, () => setFeedLoaded(true));
  }, []);
  const ingestEnvelope = useCallback((envelope: TunnelEnvelope): void => {
    setFeed((current) => upsertEnvelope(current, envelope));
  }, []);
  useEffect(() => mountFeed(setFeed, mounted, loadConversation), [loadConversation]);
  useEffect(() => onConnectionChanged(setConnection), []);
  return { feed, feedLoaded, connection, loadConversation, ingestEnvelope };
}

function isTunnelRoom(candidate: unknown): candidate is TunnelRoom {
  const room = candidate as TunnelRoom | null;
  return typeof room?.roomId === 'string' && typeof room.name === 'string' && Array.isArray(room.members);
}

function fetchRooms(apply: (rooms: TunnelRoom[]) => void, onSettled?: () => void): void {
  fetch('/api/rooms')
    .then((response) => response.json())
    .then((data: { rooms?: unknown[] }) => apply((data.rooms ?? []).filter(isTunnelRoom)))
    .catch(() => {})
    .finally(() => onSettled?.());
}

/** One fetch now, `rooms-changed` snapshots after. Resilience fallback: a
 * post addressed to a room this client has never seen means the roster moved
 * while we weren't looking — refetch. Returns the unwatch. */
/** Exported for the reconnect-wiring test — the hook is its only app caller. */
export function watchRooms(
  apply: (rooms: TunnelRoom[]) => void,
  knows: (roomId: string) => boolean,
  onSettled?: () => void,
): () => void {
  fetchRooms(apply, onSettled);
  const unsubscribeRooms = onRoomsChanged((payload) => {
    if (Array.isArray(payload)) apply(payload.filter(isTunnelRoom));
  });
  const unsubscribeEnvelopes = onMessageEnvelope((payload) => {
    if (isEnvelope(payload) && isRoomId(payload.to) && !knows(payload.to)) fetchRooms(apply);
  });
  const offReload = refetchOnReconnect(() => fetchRooms(apply)); // C5: rooms made during an outage
  return () => {
    unsubscribeRooms();
    unsubscribeEnvelopes();
    offReload();
  };
}

/** Live room roster for the messenger. ingestRoom folds a POST /api/rooms
 * response in without waiting for the ws echo. */
function roomsApplier(
  known: { current: Set<string> },
  setRooms: (rooms: TunnelRoom[]) => void,
  isLive: () => boolean,
): (next: TunnelRoom[]) => void {
  return (next) => {
    if (!isLive()) return;
    known.current = new Set(next.map((entry) => entry.roomId));
    setRooms(next);
  };
}

export function useTunnelRooms(): { rooms: TunnelRoom[]; roomsLoaded: boolean; ingestRoom: (room: TunnelRoom) => void } {
  const [rooms, setRooms] = useState<TunnelRoom[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const known = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false; connect();
    const apply = roomsApplier(known, setRooms, () => !cancelled);
    const unwatch = watchRooms(apply, (roomId) => known.current.has(roomId), () => setRoomsLoaded(true));
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);
  function ingestRoom(room: TunnelRoom): void {
    known.current.add(room.roomId);
    setRooms((current) => upsertRoom(current, room));
  }
  return { rooms, roomsLoaded, ingestRoom };
}
