// Durable people projection (mission_mission-control-ux, rulings S3 + M2).
// The people directory beside the capability feed (N4): one fetch of
// GET /api/people on mount, a re-pull on every ws 'connected' transition
// (C5 pattern — frames dropped in an outage come back through the read
// interface), and failed reads keep the LAST GOOD list under an honest
// `stale` flag instead of wiping the panel. Identity is durable agentId
// everywhere; dm:<name> conversation ids remain presentation only. The
// shared panel row model lives beside this in ../panel/. (This lib is the
// PeopleHub lane — NOT messaging; it survived the tunnelModel deletion.)
import { useEffect, useState } from 'react';
import type { ArchiveResponse, ArchivedLane, PeopleResponse, PersonView } from '../../../../shared/people/schema.js';
import { connect } from '../../agentSocket/index.js';
import {
  CHRIS,
  conversationIdsFor,
  refetchOnReconnect,
  type Conversation,
  type ConversationId,
  type TunnelEnvelope,
} from '../../messagingV2/index.js';

/* ---------- Lane pruning (C3, audit S2 — moved here for ruling D2) ----------
   Chris sees only lanes he is party to. Precedence RULED by the audit —
   history dominates registration:
     (a) DM lane WITH history → visible ONLY if Chris is a party to that
         history; a registered agent whose lane holds nothing but
         agent↔agent traffic stays hidden.
     (b) EMPTY DM lane → kept iff its agent is registered, ANY status —
         Chris can start a DM with any teammate, running or exited.
     (c) the #team channel → always visible.
     (d) rooms → visible only when Chris is a member.
   Pure presentation-layer filter: conversationIdsFor is untouched and its
   fan-out semantics stay intact for attention/readCursor/review consumers.
   BOTH rails consume this now — "registered" means known to the people
   directory (durable ∪ runtime). */
function dmLaneStanding(feed: TunnelEnvelope[]): { hasHistory: Set<ConversationId> } {
  const hasHistory = new Set<ConversationId>();
  for (const message of feed) {
    for (const laneId of conversationIdsFor(message)) {
      if (laneId.startsWith('dm:')) hasHistory.add(laneId);
    }
  }
  return { hasHistory };
}

/** Lane pruning (C3 + audit F2): (a) a dm lane with feed history is ALWAYS
 * visible — R3 serves only the human's own direct threads, so any served dm
 * lane is human-party by contract (the old chrisParty rule pruned
 * incoming-only lanes); (b) an empty dm lane materializes for a REGISTERED
 * agent, any status; (c) channels always; (d) rooms are member lanes
 * (D-N3-1). */
export function visibleLanesFor(
  lanes: Conversation[],
  feed: TunnelEnvelope[],
  agents: { title: string }[],
): Conversation[] {
  const registered = new Set(agents.map((agent) => agent.title));
  const { hasHistory } = dmLaneStanding(feed);
  return lanes.filter((entry) => {
    if (entry.kind === 'channel') return true;
    if (entry.kind === 'room') return entry.members?.includes(CHRIS) ?? false;
    if (hasHistory.has(entry.id)) return true;
    return registered.has(entry.title);
  });
}

export interface PeopleSnapshot {
  people: PersonView[];
  /** Room lane ids the default view excludes (S1) — detail on demand. */
  archivedLaneIds: string[];
  /** True once the first fetch settled (success OR failure). */
  loaded: boolean;
  /** True while the newest read failed — the list shown is the last good one. */
  stale: boolean;
}

export function emptyPeopleSnapshot(): PeopleSnapshot {
  return { people: [], archivedLaneIds: [], loaded: false, stale: false };
}

type ApplyPeople = (update: (current: PeopleSnapshot) => PeopleSnapshot) => void;

function loadPeople(apply: ApplyPeople): void {
  fetch('/api/people')
    .then((response) => response.json())
    .then((data: PeopleResponse) => apply(() => ({ people: data.people ?? [], archivedLaneIds: data.archivedLaneIds ?? [], loaded: true, stale: false })))
    .catch(() => apply((current) => ({ ...current, loaded: true, stale: true })));
}

/** Exported seam (mirrors mountFeed/watchRooms): the hook is its only app
 * caller; tests drive it directly. Returns the unmount. */
export function mountPeople(apply: ApplyPeople): () => void {
  let live = true;
  const guarded: ApplyPeople = (update) => {
    if (live) apply(update);
  };
  connect();
  loadPeople(guarded);
  const offReload = refetchOnReconnect(() => loadPeople(guarded));
  return () => {
    live = false;
    offReload();
  };
}

export function usePeople(): PeopleSnapshot {
  const [snapshot, setSnapshot] = useState<PeopleSnapshot>(emptyPeopleSnapshot);
  useEffect(() => mountPeople((update) => setSnapshot(update)), []);
  return snapshot;
}

/* ---------- On-demand archive read (ruling S1, Task 5.3) --------------------
   The default lane payloads stay lean: the archive endpoint is fetched only
   when Chris opens the disclosure. */

export interface ArchiveState {
  lanes: ArchivedLane[];
  loaded: boolean;
  failed: boolean;
}

export function useArchive(open: boolean): ArchiveState {
  const [state, setState] = useState<ArchiveState>({ lanes: [], loaded: false, failed: false });
  useEffect(() => {
    if (!open || state.loaded) return;
    let live = true;
    fetch('/api/people/archive')
      .then((response) => response.json())
      .then((data: ArchiveResponse) => {
        if (live) setState({ lanes: data.archived ?? [], loaded: true, failed: false });
      })
      .catch(() => {
        if (live) setState({ lanes: [], loaded: true, failed: true });
      });
    return () => {
      live = false;
    };
  }, [open, state.loaded]);
  return state;
}
