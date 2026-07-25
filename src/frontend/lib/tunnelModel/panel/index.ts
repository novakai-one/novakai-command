// Shared panel view-model (mission_mission-control-ux Task 2.3, ruling
// msg_d528e320): ONE row set both rails render. Identity/grouping/React keys
// are the durable agentId (rowId); the dm:<name> conversation id is TRANSPORT
// only — two durable people sharing a display name are two rows addressing
// one mailbox (known, filed external-envelope-id limitation). Buckets:
//   live     — liveness tier live or external-verified (Ruling 3: the tier is
//              derived ONCE in PeopleHub; this model never re-derives truth).
//   quiet    — not live, not archived, and reachable: a Chris-party lane
//              exists (recency order), or identity is durable. Unverified
//              externals sit here — never promoted on stale durable truth.
//   archived — durable retired/failed, plus dead sessions (runtime-only
//              exited with no lane): out of the default view (#6/#7).
// Rooms pass through in buildConversations' recency order — per-view chrome
// (caps, ROOM_LIMIT) may WINDOW these arrays but never reorder them (M1).
import type { ArchivedLane, PersonView } from '../../../../shared/people/schema.js';
import { dmId, type Conversation, type ConversationId } from '../../messagingV2/index.js';

export interface PanelPersonRow {
  /** Durable agentId; falls back to the lane id ONLY when no identity exists. */
  rowId: string;
  /** Transport pointer: dm:<mailboxName>. Never an identity key. */
  conversationId: ConversationId;
  /** null = feed-history name the object model has never heard of. */
  person: PersonView | null;
  /** The derived lane when history/registration produced one. */
  lane: Conversation | null;
}

export interface PanelLanes {
  rooms: Conversation[];
  live: PanelPersonRow[];
  quiet: PanelPersonRow[];
  archived: PanelPersonRow[];
}

function isLivePerson(person: PersonView): boolean {
  return person.liveness === 'live' || person.liveness === 'external-verified';
}

function isArchivedPerson(person: PersonView, lane: Conversation | undefined): boolean {
  if (person.liveness === 'retired' || person.liveness === 'failed') return true;
  // Dead session: runtime-only exited with nothing said in any Chris-party lane.
  return person.durableStatus === null && person.liveness === 'exited' && !lane;
}

function byName(left: PanelPersonRow, right: PanelPersonRow): number {
  return (left.person?.name ?? left.rowId).localeCompare(right.person?.name ?? right.rowId);
}

/** Quiet rows read in lane-recency order; lane-less durable rows go last, alpha. */
function byLaneRecency(left: PanelPersonRow, right: PanelPersonRow): number {
  const leftAt = left.lane?.lastMessageAt ?? '';
  const rightAt = right.lane?.lastMessageAt ?? '';
  if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
  return byName(left, right);
}

interface PersonBuckets {
  live: PanelPersonRow[];
  quiet: PanelPersonRow[];
  archived: PanelPersonRow[];
}

/** People → bucketed rows; lanes only history knows about join quiet. */
function bucketPeople(people: PersonView[], dmLanes: Map<string, Conversation>): PersonBuckets {
  const buckets: PersonBuckets = { live: [], quiet: [], archived: [] };
  const namesWithIdentity = new Set<string>();
  for (const person of people) {
    namesWithIdentity.add(person.name);
    const lane = dmLanes.get(person.name) ?? null;
    const personRow: PanelPersonRow = { rowId: person.agentId, conversationId: dmId(person.name), person, lane };
    if (isLivePerson(person)) buckets.live.push(personRow);
    else if (isArchivedPerson(person, lane ?? undefined)) buckets.archived.push(personRow);
    else buckets.quiet.push(personRow);
  }
  for (const [name, lane] of dmLanes) {
    if (namesWithIdentity.has(name)) continue;
    buckets.quiet.push({ rowId: lane.id, conversationId: lane.id, person: null, lane });
  }
  return buckets;
}

export function buildPanelLanes(
  conversations: Conversation[],
  people: PersonView[],
  _feed: unknown[],
  archivedLaneIds: readonly string[] = [],
): PanelLanes {
  // S1 default view: archived/closed-mission room lanes leave the room list;
  // they stay reachable through the archive disclosure (and search).
  const archivedRoomIds = new Set(archivedLaneIds);
  const rooms = conversations.filter((lane) => lane.kind !== 'dm' && !archivedRoomIds.has(lane.id));
  const dmLanes = new Map(conversations.filter((lane) => lane.kind === 'dm').map((lane) => [lane.title, lane]));
  const buckets = bucketPeople(people, dmLanes);
  return {
    rooms,
    live: buckets.live.sort(byName),
    quiet: buckets.quiet.sort(byLaneRecency),
    archived: buckets.archived.sort(byName),
  };
}

/** Merge the fetched archive with client-known archived person rows: fetched
 * entries are authoritative; client rows fill in what the endpoint cannot
 * know (dead runtime-only sessions). Everything keys by stable id. */
export function mergeArchive(fetched: ArchivedLane[], clientRows: PanelPersonRow[]): ArchivedLane[] {
  const seen = new Set(fetched.map((lane) => lane.id));
  const extras: ArchivedLane[] = clientRows
    .filter((personRow) => !seen.has(personRow.rowId))
    .map((personRow) => ({
      id: personRow.rowId,
      kind: 'person' as const,
      title: personRow.person?.name ?? personRow.lane?.title ?? personRow.rowId,
      conversationId: personRow.conversationId,
      reason: 'person-retired' as const,
      missionId: null,
      sourceRefs: [],
    }));
  const rooms = fetched.filter((lane) => lane.kind === 'room');
  const people = [...fetched.filter((lane) => lane.kind === 'person'), ...extras];
  return [...rooms, ...people.sort((left, right) => left.title.localeCompare(right.title))];
}
