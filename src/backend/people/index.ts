// PeopleHub (mission_mission-control-ux, ruling S3) — the read-only people
// directory over the durable object model. MessagingHub shape: narrow injected
// collaborators, registerRoutes(app), error mapped at the edge. Identity law:
// durable agentId is the ONLY join/grouping key; runtime presence attaches by
// agentId (backend spawns reuse the one minted durable id — there is no second
// mint), a runtime entry the model has never heard of stays a runtime-only row,
// and a durable person with no runtime entry renders runtime: null — for a
// registered external session that absence is the honest state. Display names
// are never folded: duplicate names in the live store are distinct people.
// Liveness law (mission_visual-truth, Ruling 3): the durable status is NEVER
// rendered raw — `liveness` is derived here once (live > external-verified >
// unverified > exited > retired/failed) and every surface renders that tier.

import type { Express, Request, Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { ArchiveResponse, ArchivedLane, PeopleResponse, PersonView } from '../../shared/people/schema.js';
import type { AgentInfo } from '../terminal/manager.js';
import type { AgentBlock } from '../objectModel/index.js';
import { personIdForAgentId } from '../messagingV2/authority/index.js';
import { lastActivityBySenderId } from '../messagingV2/journal/index.js';

/** The slices of the object model this hub reads. The archive resolvers are
 * optional so the people directory works standalone (tests, minimal wiring). */
export interface PeopleSource {
  listAgents(): AgentBlock[];
  missionForRoom?(roomId: string): string | null;
  missionRecord?(missionId: string): Record<string, unknown> | null;
}

const DURABLE_STATUSES = new Set(['spawning', 'live', 'failed', 'retired']);

/** How long journal activity stays fresh enough to verify an external session
 * (Ruling 3, mission_visual-truth). Past it, a durable-live external reads
 * `unverified` — honesty, not a bug. */
export const EXTERNAL_ACTIVITY_TTL_MS = 10 * 60 * 1000;

export type LivenessTier = PersonView['liveness'];

/** Extra reads for the tiered liveness derivation (Ruling 3). The journal is
 * optional so the people directory still works standalone (tests, minimal
 * wiring) — without it every external session derives `unverified`, never
 * a guessed green. `now` is injectable for tests. */
export interface PeopleHubOptions {
  journalPath?: string;
  now?: () => number;
}

/** Tiered honest liveness (Ruling 3 ordering law):
 * live > external-verified > unverified > exited > retired/failed.
 * - runtime running → live (the PTY is provably alive)
 * - retired/failed → retired/failed (durable truth; never promote)
 * - runtime exited → exited (runtime wins over stale durable 'live')
 * - durable live/spawning with NO runtime → external session: fresh journal
 *   activity verifies it, anything else is unverified — NEVER green on stale
 *   durable truth alone (the ghost-liveness defect class). */
function livenessFor(
  durableStatus: PersonView['durableStatus'],
  runtime: { status: 'running' | 'exited' } | null,
  lastActivityMs: number | null,
  nowMs: number,
): LivenessTier {
  if (durableStatus === 'retired') return 'retired';
  if (durableStatus === 'failed') return 'failed';
  if (runtime?.status === 'running') return 'live';
  if (runtime?.status === 'exited') return 'exited';
  if (durableStatus === 'live' || durableStatus === 'spawning') {
    const fresh = lastActivityMs !== null && nowMs - lastActivityMs >= 0 && nowMs - lastActivityMs < EXTERNAL_ACTIVITY_TTL_MS;
    return fresh ? 'external-verified' : 'unverified';
  }
  return 'exited'; // runtime-only exited with no durable identity
}

/** Parse one journal line into sender + activity instant, or null (torn lines,
 * missing fields, and the `ts` trap all parse to null — createdAt or nothing). */
function activityOf(line: string): { from: string; stamp: number } | null {
  try {
    const parsed = JSON.parse(line) as { from?: unknown; createdAt?: unknown } | null;
    const from = typeof parsed?.from === 'string' ? parsed.from : null;
    const stamp = typeof parsed?.createdAt === 'string' ? Date.parse(parsed.createdAt) : Number.NaN;
    return from !== null && !Number.isNaN(stamp) ? { from, stamp } : null;
  } catch {
    return null; // torn/corrupt line never blocks the rest (MessageStore tolerance)
  }
}

/** Last journal activity per sender name (createdAt — NOT ts). */
function lastActivityBySender(journalPath: string): Map<string, number> {
  const lastByName = new Map<string, number>();
  if (!existsSync(journalPath)) return lastByName;
  for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const activity = activityOf(line);
    if (activity && activity.stamp > (lastByName.get(activity.from) ?? Number.NEGATIVE_INFINITY)) {
      lastByName.set(activity.from, activity.stamp);
    }
  }
  return lastByName;
}

function refValue(block: AgentBlock, kind: string): string | null {
  const typedRef = block.refs?.find((entry) => entry.kind === kind);
  return typeof typedRef?.value === 'string' ? typedRef.value : null;
}

function durablePerson(block: AgentBlock, runtime: AgentInfo | undefined, liveness: LivenessTier): PersonView {
  return {
    agentId: block.id,
    name: block.name,
    provider: block.provider,
    durableStatus: DURABLE_STATUSES.has(block.status) ? block.status : null,
    liveness,
    missionId: refValue(block, 'mission'),
    teamId: refValue(block, 'team'),
    runtime: runtime ? { status: runtime.status } : null,
    sessionId: block.sessionId ?? runtime?.sessionId ?? null,
    updated: typeof block.updated === 'string' ? block.updated : null,
  };
}

function runtimeOnlyPerson(info: AgentInfo, nowMs: number): PersonView {
  return {
    agentId: info.agentId,
    name: info.title,
    provider: info.provider,
    durableStatus: null, // unknown to the object model — never invented
    liveness: livenessFor(null, { status: info.status }, null, nowMs),
    missionId: null,
    teamId: null,
    runtime: { status: info.status },
    sessionId: info.sessionId || null,
    updated: null,
  };
}

const CLOSED_MISSION_STATUSES = new Set(['done', 'closed', 'refiled']);

/** Tolerant room fold INCLUDING archived records (ruling S1): the frozen
 * RoomStore.list()/get() contract stays untouched — this is a separate
 * read-only path over the same JSONL, folded by roomId, last line wins. */
function foldRoomsWithArchived(roomsPath: string): Map<string, Record<string, unknown>> {
  const folded = new Map<string, Record<string, unknown>>();
  if (!existsSync(roomsPath)) return folded;
  for (const line of readFileSync(roomsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const roomId = (parsed as { roomId?: unknown } | null)?.roomId;
      if (typeof roomId === 'string') folded.set(roomId, parsed as Record<string, unknown>);
    } catch {
      // torn/corrupt line never blocks the rest (MessageStore tolerance)
    }
  }
  return folded;
}

export class PeopleHub {
  constructor(
    private readonly source: PeopleSource,
    /** Live backend-owned PTY list (already archived-filtered upstream). */
    private readonly runtimeAgents: () => AgentInfo[],
    /** Rooms JSONL path for the on-demand archive read; omit to serve people only. */
    private readonly roomsPath?: string,
    /** Liveness derivation inputs (Ruling 3); optional, never guessed. */
    private readonly options: PeopleHubOptions = {},
  ) {}

  registerRoutes(application: Express): void {
    application.get('/api/people', (request, response) => this.handlePeople(request, response));
    application.get('/api/people/archive', (request, response) => this.handleArchive(request, response));
  }

  /** The explicit on-demand archive read (ruling S1): archived rooms, rooms
   * whose thread-linked mission is closed, and retired durable people. */
  listArchive(): ArchiveResponse {
    return { archived: [...this.archivedRoomLanes(), ...this.retiredPeopleLanes()], asOf: new Date().toISOString() };
  }

  /** ONE room scan serves both reads: full lanes here, ids for the default
   * people payload (DRY — the classification rule lives once). */
  private archivedRoomLanes(): ArchivedLane[] {
    const lanes: ArchivedLane[] = [];
    if (!this.roomsPath) return lanes;
    for (const [roomId, block] of foldRoomsWithArchived(this.roomsPath)) {
      const title = typeof block.name === 'string' ? block.name : roomId;
      if (block.archived === true) {
        lanes.push({ id: roomId, kind: 'room', title, conversationId: roomId, reason: 'room-archived', missionId: null, sourceRefs: [{ store: 'rooms', recordId: roomId }] });
        continue;
      }
      const missionId = this.closedMissionFor(roomId);
      if (missionId) {
        lanes.push({
          id: roomId, kind: 'room', title, conversationId: roomId, reason: 'mission-closed', missionId,
          sourceRefs: [{ store: 'rooms', recordId: roomId }, { store: 'missions', recordId: missionId }],
        });
      }
    }
    return lanes;
  }

  /** The thread-linked mission id, only when that mission is closed. */
  private closedMissionFor(roomId: string): string | null {
    const missionId = this.source.missionForRoom?.(roomId) ?? null;
    if (!missionId) return null;
    const mission = this.source.missionRecord?.(missionId);
    return mission && CLOSED_MISSION_STATUSES.has(String(mission.status ?? '')) ? missionId : null;
  }

  private retiredPeopleLanes(): ArchivedLane[] {
    return this.source.listAgents()
      .filter((block) => block.status === 'retired' || block.status === 'failed')
      .map((block) => ({
        id: block.id, kind: 'person' as const, title: block.name, conversationId: `dm:${block.name}`,
        reason: 'person-retired' as const, missionId: null, sourceRefs: [{ store: 'agents', recordId: block.id }],
      }));
  }

  /** The whole directory: durable people first (runtime attached by agentId),
   * then runtime-only rows the object model has never heard of. Carries the
   * archived room-lane ids so the default view can exclude them without
   * pulling the full archive detail (S1). Liveness is derived here, once —
   * every surface renders this tier (Ruling 3). */
  listPeople(): PeopleResponse {
    const nowMs = this.options.now?.() ?? Date.now();
    const activity = this.options.journalPath ? lastActivityBySenderId(this.options.journalPath) : new Map<string, number>();
    const runtimeById = new Map(this.runtimeAgents().map((info) => [info.agentId, info]));
    const people: PersonView[] = [];
    for (const block of this.source.listAgents()) {
      const runtime = runtimeById.get(block.id);
      const durableStatus = DURABLE_STATUSES.has(block.status) ? block.status : null;
      const liveness = livenessFor(durableStatus, runtime ? { status: runtime.status } : null, activity.get(personIdForAgentId(block.id)) ?? null, nowMs);
      people.push(durablePerson(block, runtime, liveness));
      runtimeById.delete(block.id);
    }
    for (const info of runtimeById.values()) people.push(runtimeOnlyPerson(info, nowMs));
    return { people, archivedLaneIds: this.archivedRoomIds(), asOf: new Date().toISOString() };
  }

  private archivedRoomIds(): string[] {
    return this.archivedRoomLanes().map((lane) => lane.id);
  }

  private handlePeople(_request: Request, response: Response): void {
    try {
      response.json(this.listPeople());
    } catch (error) {
      this.sendFailure(response, error);
    }
  }

  private handleArchive(_request: Request, response: Response): void {
    try {
      response.json(this.listArchive());
    } catch (error) {
      this.sendFailure(response, error);
    }
  }

  private sendFailure(response: Response, error: unknown): void {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
