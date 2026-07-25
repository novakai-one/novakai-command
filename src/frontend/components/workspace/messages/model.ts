// Messages tab view-model — every derived decision lives here as typed,
// pure, testable data. Components stay dumb: they render what these
// functions return. Change a rule here and the whole tab follows.
import type { AgentInfo } from '../../../lib/agentSocket/index.js';
import { agentObjectId, type MentionTarget } from '../../../lib/mentions/index.js';
import {
  CHRIS,
  conversationIdsFor,
  isRoomId,
  type Conversation,
  type ConversationId,
  type TunnelEnvelope,
} from '../../../lib/messagingV2/index.js';

/* ---------- Density-as-data (owner decision, locked) -----------------------
   The whole tab rescales from this ONE knob: MessagesView writes
   DENSITY_SCALE[settings.density] onto .msg-view as --msg-scale and every
   size token in tokens.css is calc(spec px × --msg-scale). App-level setting
   concept — a constant today, a settings toggle tomorrow (swap the source of
   MESSAGING_SETTINGS, nothing else changes). */
export type MessagingDensity = 'low' | 'normal' | 'high';

export interface MessagingTabSettings {
  density: MessagingDensity;
  /** Long messages collapse to a snippet past this many characters. */
  messageDisplay: {
    collapseOverChars: number;
  };
  /** @ mention picker in the composer. */
  mentionPicker: {
    maxSuggestions: number;
  };
  /** Delivery status grammar (see rowDeliveryFor). */
  delivery: {
    /** A 'queued' envelope younger than this shows "Sending…". */
    sendingWindowMs: number;
  };
  /** Review button in the right panel (see reviewLanesFor). */
  review: {
    /** How long to wait for the target row to render before giving up honestly. */
    scrollTimeoutMs: number;
  };
  /** Send-and-know (round 3 M7 — see isOwnFreshSend / userScrollActive). */
  sendFollow: { ownSendWindowMs: number; scrollGuardMs: number };
  /** Bounded rail (mission messages-tab-v1 C1, audit S4 — see capRailLanes). */
  rail: { cap: number; page: number; ceiling: number };
  /** Windowed thread (C1 + M3 anchored review — see windowMessages). */
  thread: { windowSize: number };
}

export const DENSITY_SCALE: Record<MessagingDensity, number> = {
  // eslint-disable-next-line id-length -- owner's locked density name (low|normal|high)
  low: 1.0,
  normal: 1.3,
  high: 1.7,
};

export const MESSAGING_SETTINGS: MessagingTabSettings = {
  density: 'normal',
  messageDisplay: { collapseOverChars: 280 },
  mentionPicker: { maxSuggestions: 6 },
  delivery: { sendingWindowMs: 60_000 },
  review: { scrollTimeoutMs: 2_000 },
  sendFollow: { ownSendWindowMs: 10_000, scrollGuardMs: 1_200 },
  // eslint-disable-next-line id-length -- 'cap' is the Chief-named knob (rail cap)
  rail: { cap: 50, page: 50, ceiling: 150 },
  thread: { windowSize: 100 },
};

/* ---------- Delivery status grammar (round 2 — states settle honestly) -----
   'queued' is transient by design: the router amends every envelope to
   delivered/failed inside the send, and the UI folds the settled 201 copy
   straight into the feed. A queued envelope older than the window lost its
   receipt (process died mid-route, an outside writer bypassed the router, or
   the ws amendment never reached this client) — "Sending…" forever is a lie.
   Chris' own stale sends surface as "Not delivered"; other senders' stale
   rows go quiet (for a human reader, the record you are reading IS arrival). */
export type RowDelivery = 'sending' | 'failed' | 'undelivered' | 'quiet';

export function rowDeliveryFor(envelope: TunnelEnvelope, nowMs: number): RowDelivery {
  if (envelope.status === 'failed') return 'failed';
  if (envelope.status !== 'queued') return 'quiet';
  const ageMs = nowMs - Date.parse(envelope.createdAt);
  if (ageMs >= 0 && ageMs < MESSAGING_SETTINGS.delivery.sendingWindowMs) return 'sending';
  return envelope.from === CHRIS ? 'undelivered' : 'quiet';
}

/* ---------- @ mention picker (round 2 — composer) ---------------------------
   Typing @ at a word boundary opens the picker; the query is the run of
   non-space characters between the @ and the caret. Picking replaces
   "@query" with "@label " — MentionText resolves the label downstream. */
export interface MentionQuery {
  /** Index of the '@' in the draft. */
  start: number;
  /** Text between the '@' and the caret. */
  query: string;
}

export function mentionQueryAt(draft: string, caret: number): MentionQuery | null {
  const before = draft.slice(0, caret);
  const atIndex = before.lastIndexOf('@');
  if (atIndex === -1) return null;
  // The @ must open a token: start of draft, after whitespace, or after an
  // abandoned @ (typing "@@" restarts the picker on the second sign).
  if (atIndex > 0 && !/[\s@]/.test(before[atIndex - 1])) return null;
  const query = before.slice(atIndex + 1);
  return /\s/.test(query) ? null : { start: atIndex, query };
}

/** Prefix matches first, then substring matches, capped at the typed limit.
 *  Labels dedupe — the roster can carry two agents under one exact name. */
export function mentionSuggestions(targets: MentionTarget[], query: string, limit: number): MentionTarget[] {
  const needle = query.toLowerCase();
  const seen = new Set<string>();
  const agents = targets.filter((target) => {
    if (target.kind !== 'agent' || seen.has(target.label)) return false;
    seen.add(target.label);
    return true;
  });
  const prefix = agents.filter((target) => target.label.toLowerCase().startsWith(needle));
  const rest = agents.filter((target) => !prefix.includes(target) && target.label.toLowerCase().includes(needle));
  return [...prefix, ...rest].slice(0, limit);
}

/* ---------- Collapsible messages (round 2 — calm over walls of text) -------
   A body longer than the threshold renders as a flattened snippet; clicking
   the row (or the more/less affordance) toggles the full markdown. Short
   messages always render full and carry no affordance. */
export function isCollapsible(body: string): boolean {
  return body.length > MESSAGING_SETTINGS.messageDisplay.collapseOverChars;
}

/** The collapsed view: whitespace flattened, cut at the threshold. */
export function snippetFor(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const limit = MESSAGING_SETTINGS.messageDisplay.collapseOverChars;
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

/* ---------- Rail widths (round 2 — drag handles, persisted) ----------------
   Both outer columns resize between typed clamps; the pair persists to
   localStorage as one typed object. Parse failures and out-of-range values
   fall back to the storyboard defaults. */
export interface RailWidths {
  rail: number;
  context: number;
}

export const RAIL_WIDTH_LIMITS: Record<keyof RailWidths, { floor: number; ceiling: number }> = {
  rail: { floor: 180, ceiling: 360 },
  context: { floor: 220, ceiling: 440 },
};

export const DEFAULT_RAIL_WIDTHS: RailWidths = { rail: 230, context: 280 };

const RAIL_WIDTHS_KEY = 'novakai.messages.rail-widths.v1';

export function clampRailWidth(kind: keyof RailWidths, pixels: number): number {
  const limits = RAIL_WIDTH_LIMITS[kind];
  if (!Number.isFinite(pixels)) return DEFAULT_RAIL_WIDTHS[kind];
  const rounded = Math.round(pixels);
  if (rounded < limits.floor) return limits.floor;
  if (rounded > limits.ceiling) return limits.ceiling;
  return rounded;
}

export function parseRailWidths(text: string | null): RailWidths {
  if (!text) return DEFAULT_RAIL_WIDTHS;
  try {
    const parsed = JSON.parse(text) as Partial<RailWidths>;
    return {
      rail: clampRailWidth('rail', Number(parsed.rail)),
      context: clampRailWidth('context', Number(parsed.context)),
    };
  } catch {
    return DEFAULT_RAIL_WIDTHS;
  }
}

export function loadRailWidths(): RailWidths {
  try {
    return parseRailWidths(globalThis.localStorage?.getItem(RAIL_WIDTHS_KEY) ?? null);
  } catch {
    return DEFAULT_RAIL_WIDTHS;
  }
}

export function saveRailWidths(widths: RailWidths): void {
  try {
    globalThis.localStorage?.setItem(RAIL_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Private-mode storage failures never break a drag.
  }
}

/* ---------- Presence tones (D-N4-5) ------------------------------------------
   The invented feed-derived heuristic is DELETED — rail/person rows use
   PeopleHub liveness tiers (the ONE server-derived liveness truth, Ruling 3).
   The feed lib carries NO presence plumbing (F11): unread → amber
   "notification"; live-verified → green; anything else → gray. */
export type PresenceTone = 'amber' | 'green' | 'gray';

export const PRESENCE_LABEL: Record<PresenceTone, string> = {
  amber: 'notification',
  green: 'online',
  gray: 'offline',
};

/* ---------- Rail sections ---------------------------------------------------
   MISSION ROOMS = #team channel pinned first, then rooms (recency order as
   delivered by buildConversations); DIRECT MESSAGES = dm lanes. TEAMS is
   hidden by owner decision (no backend concept of "team"). */
export interface RailSections {
  rooms: Conversation[];
  directs: Conversation[];
}

export function splitRailSections(conversations: Conversation[]): RailSections {
  const channels = conversations.filter((lane) => lane.kind === 'channel');
  const rooms = conversations.filter((lane) => lane.kind === 'room');
  const directs = conversations.filter((lane) => lane.kind === 'dm');
  return { rooms: [...channels, ...rooms], directs };
}

/** Rail/composer label for a room lane: '#team' → 'team', 'room_…' → its name. */
export function roomLabelFor(conversation: Conversation): string {
  return conversation.title.replace(/^#/, '');
}

/* ---------- Lane pruning (C3, audit S2) --------------------------------------
   Moved to the shared model (Task 2.4): both rails prune now (ruling D2), so
   the rule lives in tunnelModel/people.ts. Re-exported here so this module's
   existing consumers and tests keep their import surface. */
export { visibleLanesFor } from '../../../lib/tunnelModel/people/index.js';

/* ---------- Distinct rail labels (C2, audit M1) ------------------------------
   Presentation-layer disambiguation ONLY — no identity or envelope change.
   When two lanes would render the identical label, each collider gets the
   SHORTEST id suffix that tells the collision set apart: start at 4 chars,
   extend one char at a time, fall back to the full id. Collisions span
   sections (a room named 'team' collides with the #team channel label). */
function railLabelBase(conversation: Conversation): string {
  return conversation.kind === 'dm' ? conversation.title : roomLabelFor(conversation);
}

const SUFFIX_START = 4;

function shortestUniqueSuffixes(laneIds: string[]): Map<string, string> {
  const longest = Math.max(...laneIds.map((laneId) => laneId.length));
  for (let length = SUFFIX_START; length <= longest; length += 1) {
    const suffixes = laneIds.map((laneId) => laneId.slice(-length));
    if (new Set(suffixes).size === laneIds.length) {
      return new Map(laneIds.map((laneId, index) => [laneId, suffixes[index]]));
    }
  }
  return new Map(laneIds.map((laneId) => [laneId, laneId])); // full-id fallback
}

export function distinctRailLabels(lanes: Conversation[]): Map<ConversationId, string> {
  const byLabel = new Map<string, Conversation[]>();
  for (const entry of lanes) {
    const base = railLabelBase(entry);
    byLabel.set(base, [...(byLabel.get(base) ?? []), entry]);
  }
  const labels = new Map<ConversationId, string>();
  for (const [base, group] of byLabel) {
    if (group.length === 1) {
      labels.set(group[0].id, base);
      continue;
    }
    const suffixes = shortestUniqueSuffixes(group.map((entry) => entry.id));
    for (const entry of group) labels.set(entry.id, `${base} · ${suffixes.get(entry.id)}`);
  }
  return labels;
}

/* ---------- Bounded rail (C1, audit S4) --------------------------------------
   The rail NEVER renders more than the ceiling, no matter what sequence of
   show-more clicks arrives — there is deliberately no "return all" mode.
   Lanes beyond the ceiling are reached via search (the query runs over the
   full lane set upstream; its result passes back through this same bound).
   The #team channel is pinned first and never displaced by the bound. */
export interface CappedLanes {
  lanes: Conversation[];
  hiddenCount: number;
}

export function capRailLanes(lanes: Conversation[], visibleCount: number): CappedLanes {
  const bound = Math.min(Math.max(visibleCount, 1), MESSAGING_SETTINGS.rail.ceiling);
  const channel = lanes.find((entry) => entry.kind === 'channel');
  const rest = channel ? lanes.filter((entry) => entry !== channel) : lanes;
  const capped = channel
    ? [channel, ...rest.slice(0, bound - 1)]
    : rest.slice(0, bound);
  return { lanes: capped, hiddenCount: lanes.length - capped.length };
}

/* ---------- Windowed thread (C1 + M3) ----------------------------------------
   Default: the newest windowSize rows — no full-journal map, ever. An
   anchorId (the review flow reaching a failed envelope older than the tail)
   bounds the window AROUND the target instead, with honest counts of what
   sits outside it on each side. Unknown anchors fall back to the tail. */
export interface ThreadWindow {
  messages: TunnelEnvelope[];
  earlierCount: number;
  laterCount: number;
}

export function windowMessages(
  messages: TunnelEnvelope[],
  visibleCount: number,
  anchorId?: string,
): ThreadWindow {
  const anchorIndex = anchorId ? messages.findIndex((entry) => entry.id === anchorId) : -1;
  if (anchorIndex === -1) {
    const start = Math.max(0, messages.length - visibleCount);
    return { messages: messages.slice(start), earlierCount: start, laterCount: 0 };
  }
  const sliceEnd = Math.min(messages.length, Math.max(anchorIndex + Math.ceil(visibleCount / 2), visibleCount));
  const sliceStart = Math.max(0, sliceEnd - visibleCount);
  return {
    messages: messages.slice(sliceStart, sliceEnd),
    earlierCount: sliceStart,
    laterCount: messages.length - sliceEnd,
  };
}

/* ---------- Known agents (round 3 M5 — New room / New DM pickers) ----------
   The live roster is empty whenever no agent process is running, but the tab
   still KNOWS agents: every registered agent record (running or exited) and
   every non-chris party the feed history carries. Pickers list this union —
   live first, then alphabetical — so an empty roster never dead-ends a flow.
   Feed-only names carry no provider and no live claim: history knows their
   name, nothing more. */
export interface KnownAgent {
  name: string;
  provider: AgentInfo['provider'] | null;
  live: boolean;
}

export function knownAgentsFor(agents: AgentInfo[], feed: TunnelEnvelope[]): KnownAgent[] {
  const known = new Map<string, KnownAgent>();
  for (const agent of agents) {
    const seen = known.get(agent.title);
    if (!seen || (agent.status === 'running' && !seen.live)) {
      known.set(agent.title, { name: agent.title, provider: agent.provider, live: agent.status === 'running' });
    }
  }
  for (const envelope of feed) {
    for (const party of [envelope.from, envelope.to]) {
      if (party === CHRIS || isRoomId(party) || party.startsWith('#') || known.has(party)) continue;
      known.set(party, { name: party, provider: null, live: false });
    }
  }
  return [...known.values()].sort(
    (left, right) => Number(right.live) - Number(left.live) || left.name.localeCompare(right.name),
  );
}

/* ---------- Composer mention universe (round 3 M8a) -------------------------
   The picker's TRIGGER is fine — a word-boundary @ opens it with an empty
   query (mentionQueryAt, round 2). What failed in review was the universe:
   suggestions came from the LIVE roster only, so an empty roster (no agent
   processes running — the common case against seeded data) meant zero
   suggestions and a picker that never opened. The universe is the same
   known-agents union the M5 pickers use: live first, then registered and
   feed-history names. A mention is text, not a delivery claim — naming an
   offline agent in a room is legitimate even where a DM send to one would
   fail honestly at the router. */
export function composerTargetsFor(knownAgents: KnownAgent[]): MentionTarget[] {
  return knownAgents.map((agent) => ({ objectId: agentObjectId(agent.name), label: agent.name, kind: 'agent' }));
}

/* ---------- DM lane overlay (round 3 M5) ------------------------------------
   A freshly opened DM lane may not exist in `conversations` yet — the agent
   is registered but exited and history has never heard from them, so
   buildConversations derives no lane. The overlay stands in until Chris's
   first envelope lands and the lane derives for real. Moved to the shared
   tunnel model (mission_visual-truth defect 1): Mission Control consumes the
   same derivation now — one overlay grammar, two chromes. Re-exported here so
   this module's existing consumers and tests keep their import surface. */
export { dmLaneFor, resolveSelectedLane } from '../../../lib/messagingV2/index.js';
/* ---------- Right-panel identity header (round 3 M4) -----------------------
   Rooms/channels get the same "where you are" header DMs have: name, kind,
   member count. The count only appears when the room record carries a real
   member list — the #team channel has none, so it shows its kind alone
   rather than an invented number. */
export function roomIdentityFor(conversation: Conversation): string {
  const kind = conversation.kind === 'channel' ? 'Channel' : 'Mission room';
  if (!conversation.members) return kind;
  const count = conversation.members.length;
  return `${kind} · ${count} member${count === 1 ? '' : 's'}`;
}

/* ---------- Review resilience (round 3 M4) ----------------------------------
   A Review click targets a failed envelope. Where that envelope lives is a
   derivation, not an assumption: its lane ids, or null when it is gone from
   the feed entirely (stale notice — the honest "can't locate" case). */
export function reviewLanesFor(feed: TunnelEnvelope[], envelopeId: string): ConversationId[] | null {
  const envelope = feed.find((entry) => entry.id === envelopeId);
  return envelope ? conversationIdsFor(envelope) : null;
}

/* ---------- Send-and-know (round 3 M7) --------------------------------------
   Sending while scrolled up must not leave Chris wondering: the feed
   smooth-scrolls to the new row so its status settles in view. The ONE
   exception is a user caught mid-gesture — yanking the feed out from under
   an active scroll is worse than a moment of not-knowing, so that case gets
   a "New message ↓" dock instead (thread/index.tsx owns the dock). */
export function isOwnFreshSend(envelope: TunnelEnvelope | undefined, nowMs: number): boolean {
  if (!envelope || envelope.from !== CHRIS) return false;
  const ageMs = nowMs - Date.parse(envelope.createdAt);
  return ageMs >= 0 && ageMs < MESSAGING_SETTINGS.sendFollow.ownSendWindowMs;
}

/** True while the last wheel/touch gesture is fresh enough to mean the user
 *  is actively scrolling right now. */
export function userScrollActive(lastGestureAtMs: number | null, nowMs: number): boolean {
  return lastGestureAtMs !== null && nowMs - lastGestureAtMs < MESSAGING_SETTINGS.sendFollow.scrollGuardMs;
}

/* ---------- Rail search (round 3 M8c) ---------------------------------------
   The old rail had a search box; the rebuild dropped it. Restored as one
   honest derivation: case-insensitive substring over lane titles, both
   sections filtered through the same seam. */
export function filterRailLanes(conversations: Conversation[], query: string): Conversation[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return conversations;
  return conversations.filter((lane) => lane.title.toLowerCase().includes(needle));
}

/* ---------- Identity labels ------------------------------------------------- */
export function displayNameFor(sender: string): string {
  return sender === CHRIS ? 'Chris' : sender;
}

export function roleFor(sender: string, agents: AgentInfo[]): string {
  if (sender === CHRIS) return 'Product owner';
  return agents.find((agent) => agent.title === sender)?.provider ?? 'agent';
}

/** One-letter storyboard initial ("Chris" → C, "Maya" → M). */
export function initialFor(sender: string): string {
  return displayNameFor(sender).trim().charAt(0).toUpperCase() || '?';
}

/* ---------- "Agent working…" (D6 — heuristic; no real working signal) ------
   True when the lane's NEWEST envelope is addressed TO the agent (not from
   them), that agent is running, and the envelope is fresh. Any word from the
   agent becomes the newest envelope and clears it. */
export const WORKING_WINDOW_MS = 10 * 60 * 1000;

export function workingAgentFor(messages: TunnelEnvelope[], agents: AgentInfo[], nowMs: number): string | null {
  const latest = messages[messages.length - 1];
  if (!latest || latest.to === CHRIS || isRoomId(latest.to) || latest.to.startsWith('#')) return null;
  const agent = agents.find((entry) => entry.title === latest.to);
  if (agent?.status !== 'running') return null;
  const ageMs = nowMs - Date.parse(latest.createdAt);
  return ageMs >= 0 && ageMs < WORKING_WINDOW_MS ? latest.to : null;
}

/* ---------- Clock + day grouping ------------------------------------------- */
export function formatClockTime(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return '';
  const hours = String(parsed.getHours()).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabelFor(isoTimestamp: string, nowDate: Date): string {
  const parsed = new Date(isoTimestamp);
  if (dayKeyOf(parsed) === dayKeyOf(nowDate)) return 'TODAY';
  const month = parsed.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${month} ${parsed.getDate()}`;
}

export interface DayGroup {
  dayKey: string;
  label: string;
  messages: TunnelEnvelope[];
}

/** Split one lane's (time-ordered) transcript into per-day groups for pills. */
export function groupByDay(messages: TunnelEnvelope[], nowDate: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const message of messages) {
    const dayKey = dayKeyOf(new Date(message.createdAt));
    const last = groups[groups.length - 1];
    if (last && last.dayKey === dayKey) last.messages.push(message);
    else groups.push({ dayKey, label: dayLabelFor(message.createdAt, nowDate), messages: [message] });
  }
  return groups;
}

/* ---------- Reply context (only when data exists) ---------------------------
   envelope.threadId points at the envelope it answers; when that parent is
   known we render "Replying to <name>", otherwise nothing. */
export function replyLabelFor(
  envelope: TunnelEnvelope,
  feed: TunnelEnvelope[],
): string | null {
  if (!envelope.threadId) return null;
  const parent = feed.find((entry) => entry.id === envelope.threadId);
  return parent ? `Replying to ${displayNameFor(parent.from)}` : null;
}

/* ---------- Stats (D10 — REAL derived counts, never dummy numbers) --------- */
export interface LaneStats {
  sent: number;
  received: number;
  delivered: number;
  /** Just-sent rows not yet echoed by the committed fact (optimistic grammar). */
  queued: number;
  failed: number;
}

export function laneStatsFor(messages: TunnelEnvelope[]): LaneStats {
  const stats: LaneStats = { sent: 0, received: 0, delivered: 0, queued: 0, failed: 0 };
  for (const message of messages) {
    if (message.from === CHRIS) stats.sent += 1;
    else stats.received += 1;
    if (message.status === 'failed') stats.failed += 1;
    else if (message.status === 'delivered') stats.delivered += 1;
    else if (message.status === 'queued') stats.queued += 1;
  }
  return stats;
}

/* ---------- Summary recap (derived quiet notes — honest, no lorem) --------- */
export function recapNotesFor(
  conversation: Conversation,
  messages: TunnelEnvelope[],
  unreadCount: number,
): string[] {
  const notes: string[] = [];
  notes.push(unreadCount > 0 ? `${unreadCount} unread here.` : 'All caught up here.');
  if (conversation.members) notes.push(`${conversation.members.length} members in this room.`);
  const latest = messages[messages.length - 1];
  notes.push(latest ? `Last word ${formatClockTime(latest.createdAt)}.` : 'Nothing said yet.');
  return notes;
}

/* ---------- D3: lane restoration as a pure state machine (ruling S7) -------
   Reload must return Chris to the conversation he was in. The remembered id
   is retained while sources hydrate; a fallback is chosen only after feed,
   rooms, AND roster have ALL settled — and a fallback is never saved as a
   preference. */

export interface RestoreInputs {
  /** Restoration only runs while nothing is selected. */
  selectedId: ConversationId | null;
  /** The persisted lane id, or null when none was ever saved. */
  remembered: ConversationId | null;
  /** Lane ids currently derivable from feed + rooms + roster. */
  conversationIds: ConversationId[];
  feedLoaded: boolean;
  roomsLoaded: boolean;
  agentsLoaded: boolean;
}

export type RestoreDecision =
  | { kind: 'wait' }
  | { kind: 'restore'; id: ConversationId }
  | { kind: 'fallback'; id: ConversationId }
  | { kind: 'none' };

export function restoreDecision(inputs: RestoreInputs): RestoreDecision {
  if (inputs.selectedId !== null) return { kind: 'none' };
  if (inputs.remembered !== null && inputs.conversationIds.includes(inputs.remembered)) {
    return { kind: 'restore', id: inputs.remembered };
  }
  const settled = inputs.feedLoaded && inputs.roomsLoaded && inputs.agentsLoaded;
  if (!settled) return { kind: 'wait' }; // the remembered id is retained, never abandoned early
  const first = inputs.conversationIds[0];
  return first !== undefined ? { kind: 'fallback', id: first } : { kind: 'wait' };
}
