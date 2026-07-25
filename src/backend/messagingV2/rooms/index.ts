/**
 * messagingV2 rooms glue (slice N3 — Rooms): host-owned room Thread
 * provisioning and the browser #team shim, on top of the sealed capability
 * (the core is frozen; a READY MembershipSource means coreStack provisions
 * NOTHING — the host owns room Thread creation, Store-Seam §11.4).
 *
 * Provisioning (D-N3-2): at boot AND on agent launch, ensure room Threads
 * via embedded.store.createRoomThread (get-or-create by (authority,
 * externalId) — idempotent, not journaled): the fleet room
 * {team, fleet, team} for #team, one per teams.jsonl team, one per
 * missions.jsonl mission. The RoomDirectory keeps threadId → label
 * (`#team`, `#<team name>`, `#<mission title>`; falls back to externalId)
 * for the transport's [nvk-room …] formatting and the routes' resolution.
 *
 * N4 note: the browser #team shim (read translation + live rebroadcast)
 * is DELETED — the browser is a forwarded-frame subscriber now
 * (messagingV2/live, D-N4-1), and the fleet send path is the user send
 * route's own sendMessage (messagingV2/userRoutes). What stays here:
 * provisioning (boot + launch), the RoomDirectory (labels for the
 * transport's [nvk-room …] formatting and the routes' resolution), and
 * readTrailingPage (the routes' trailing-window paging).
 */

import type { EmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import { constants } from '../../../../packages/messaging/public/contract/index.js';
import type { Cursor, Message, ThreadId } from '../../../../packages/messaging/public/contract/index.js';
import type { ObjectModel } from '../../objectModel/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { personIdForAgentId } from '../authority/index.js';
import { FLEET_EXTERNAL_ID } from '../membership/index.js';

export const FLEET_LABEL = '#team';

/** threadId → label + key lookup, shared by transport, routes, and the shim. */
export interface RoomDirectory {
  register(threadId: ThreadId, authority: string, externalId: string, label: string): void;
  labelFor(threadId: string): string | undefined;
  threadIdFor(authority: string, externalId: string): ThreadId | undefined;
  /** N4: label (`#team`, `#<name>`) → threadId, for the user send route. */
  threadIdForLabel(label: string): ThreadId | undefined;
  fleetThreadId(): ThreadId | undefined;
}

export function createRoomDirectory(): RoomDirectory {
  const byThreadId = new Map<string, string>();
  const byKey = new Map<string, ThreadId>();
  const byLabel = new Map<string, ThreadId>();
  return {
    register(threadId, authority, externalId, label) {
      byThreadId.set(threadId, label);
      byKey.set(`${authority}/${externalId}`, threadId);
      byLabel.set(label, threadId);
    },
    labelFor: (threadId) => byThreadId.get(threadId),
    threadIdFor: (authority, externalId) => byKey.get(`${authority}/${externalId}`),
    threadIdForLabel: (label) => byLabel.get(label),
    fleetThreadId: () => byKey.get(`fleet/${FLEET_EXTERNAL_ID}`),
  };
}

export interface RoomsGlueDeps {
  embedded: EmbeddedMessaging;
  objectModel: ObjectModel;
  directory: RoomDirectory;
  terminals: TerminalRuntime;
  /** The held human session (null when no humanToken is configured). */
  humanSession: () => MessagingSession | null;
  humanPersonId: string;
  log?: (message: string) => void;
}

export interface RoomsGlue {
  ensureAllRooms(): Promise<void>;
  /** Launch-time provisioning: the launched agent's team/mission rooms. */
  handleAgentLaunched(info: AgentInfo): void;
  threadIdFor(authority: string, externalId: string): ThreadId | undefined;
  threadIdForLabel(label: string): ThreadId | undefined;
  fleetThreadId(): ThreadId | undefined;
  labelFor(threadId: string): string | undefined;
  close(): Promise<void>;
}

function announce(deps: RoomsGlueDeps, message: string): void {
  (deps.log ?? ((): void => {}))(message);
}

/** One get-or-create + directory registration; failures log, never throw. */
async function ensureRoom(
  deps: RoomsGlueDeps,
  threadKind: 'team' | 'mission',
  authority: string,
  externalId: string,
  label: string,
): Promise<ThreadId | null> {
  const created = await deps.embedded.store.createRoomThread({ threadKind, authority, externalId });
  if (created.kind === 'error') {
    announce(deps, `[messaging-v2] room provisioning failed for ${authority}/${externalId}: ${JSON.stringify(created.error)}`);
    return null;
  }
  deps.directory.register(created.value.id, authority, externalId, label);
  return created.value.id;
}

function blockLabel(block: Record<string, unknown>, fallback: string): string {
  const name = block['name'] ?? block['title'];
  return `#${typeof name === 'string' && name !== '' ? name : fallback}`;
}

async function ensureAllRooms(deps: RoomsGlueDeps): Promise<void> {
  await ensureRoom(deps, 'team', 'fleet', FLEET_EXTERNAL_ID, FLEET_LABEL);
  for (const team of deps.objectModel.listTeams()) {
    const teamId = typeof team['id'] === 'string' ? team['id'] : undefined;
    if (teamId !== undefined) await ensureRoom(deps, 'team', 'team', teamId, blockLabel(team, teamId));
  }
  for (const mission of deps.objectModel.listMissions()) {
    const missionId = typeof mission['id'] === 'string' ? mission['id'] : undefined;
    if (missionId !== undefined) await ensureRoom(deps, 'mission', 'mission', missionId, blockLabel(mission, missionId));
  }
}

/** Launch-time: provision the rooms named by the agent's durable refs. */
async function ensureForAgent(deps: RoomsGlueDeps, agentId: string): Promise<void> {
  const block = deps.objectModel.agentRecord(agentId);
  for (const reference of block?.refs ?? []) {
    if (reference.kind === 'team' || reference.kind === 'mission') {
      const record = reference.kind === 'team'
        ? deps.objectModel.teamRecord(reference.value)
        : deps.objectModel.missionRecord(reference.value);
      const label = record === null ? `#${reference.value}` : blockLabel(record, reference.value);
      await ensureRoom(deps, reference.kind, reference.kind, reference.value, label);
    }
  }
}

/** A lane failure that keeps the capability's error NAME for HTTP mapping. */
function namedFailure(name: string, message: string): Error {
  const failure = new Error(message);
  failure.name = name;
  return failure;
}

/**
 * Read the TRAILING window of a thread (FIX 4): pages are sequence-ordered
 * oldest-first, so page through nextCursor to the end and keep the newest
 * pageLimitMax messages — matching the old history's trailing-limit
 * semantics. Cost: one read per page (O(total/pageLimitMax)) per call;
 * acceptable for the shim until N4.
 */
export async function readTrailingPage(session: MessagingSession, threadId: ThreadId): Promise<Message[]> {
  let cursor: Cursor | undefined;
  const accumulated: Message[] = [];
  do {
    const outcome = await session.getMessages(cursor === undefined ? { threadId } : { threadId, cursor });
    if (outcome.kind !== 'ok') throw namedFailure(outcome.error.name, outcome.error.message);
    accumulated.push(...outcome.value.messages);
    cursor = outcome.value.nextCursor;
  } while (cursor !== undefined);
  return accumulated.slice(-constants.pageLimitMax);
}

/** Launch-time provisioning, fire-and-forget with honest failure logging. */
function launchProvision(deps: RoomsGlueDeps, info: AgentInfo): void {
  void ensureForAgent(deps, info.agentId).catch((cause: unknown) => {
    announce(deps, `[messaging-v2] launch-time room provisioning failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
}

export function createRoomsGlue(deps: RoomsGlueDeps): RoomsGlue {
  return {
    ensureAllRooms: () => ensureAllRooms(deps),
    handleAgentLaunched: (info) => launchProvision(deps, info),
    threadIdFor: (authority, externalId) => deps.directory.threadIdFor(authority, externalId),
    threadIdForLabel: (label) => deps.directory.threadIdForLabel(label),
    fleetThreadId: () => deps.directory.fleetThreadId(),
    labelFor: (threadId) => deps.directory.labelFor(threadId),
    close: () => Promise.resolve(),
  };
}
