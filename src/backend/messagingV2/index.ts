/**
 * messagingV2 composition glue (slice N1 — Foundation): boots the sealed
 * @novakai/messaging capability embedded in the app backend, wired to the
 * app's identity/membership authority (ObjectModel) through the Novakai
 * adapters in ./authority and ./membership.
 *
 * N2 (agent direct lane): when a TerminalRuntime is injected, the terminal-
 * host 'pty' presence transport (./transport) is registered and the presence
 * glue (./presence) opens+binds a lane per durable agent — on launch and at
 * boot for already-running live agents. The event bus tails on
 * busPollIntervalMs (500 ms) once start() runs — that IS the event-pump
 * interval; no separate manual pumpEvents loop is wired. The old messaging
 * surface keeps serving what N3/N4 hasn't replaced (the human lane, rooms,
 * history reads). A boot failure must never take the app down (the server
 * catches and logs it LOUD, then continues without the capability).
 *
 * Room Thread provisioning (N3): the app passes a READY MembershipSource so
 * coreStack provisions NOTHING — the rooms glue (./rooms) owns creation via
 * embedded.store.createRoomThread at boot and on launch (fleet #team room +
 * one per team + one per mission). The membership adapter serves the 'fleet'
 * authority and includes the human principal in EVERY roster (D-N3-1).
 *
 * ONE clock (createSystemClock) is shared by the store, both adapters, and
 * the embedded stack so session expiry, evidence timestamps, and journal
 * records never disagree.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbeddedMessaging } from '../../../packages/messaging/composition/embedded.js';
import type { EmbeddedMessaging } from '../../../packages/messaging/composition/embedded.js';
import { createSystemClock } from '../../../packages/messaging/adapters/clock-system.js';
import { openJsonlStore } from '../../../packages/messaging/adapters/store-jsonl.js';
import type { PersonId } from '../../../packages/messaging/public/contract/index.js';
import type { PresenceTransport } from '../../../packages/messaging/seams/presenceTransport.js';
import { CHRIS_MEMBER } from '../messaging/types.js';
import type { ObjectModel } from '../objectModel/index.js';
import type { AgentInfo } from '../terminal/manager.js';
import type { TerminalRuntime } from '../terminal/runtime/index.js';
import { createNovakaiAuthority, isActiveAgent } from './authority/index.js';
import type { NovakaiAuthorityConfig } from './authority/index.js';
import { createNovakaiMembership } from './membership/index.js';
import { createTerminalHostTransport } from './transport/index.js';
import { createAgentLaneGlue } from './presence/index.js';
import type { AgentLaneGlue } from './presence/index.js';
import { createRoomDirectory, createRoomsGlue } from './rooms/index.js';
import type { RoomsGlue } from './rooms/index.js';
import type { TokenStore } from './tokens/index.js';
import type { ExternalsStore } from './externals/index.js';
import { createDoorTransport, startDoor } from './door/index.js';
import type { DoorOptions, MessagingDoor } from './door/index.js';

/** The one human personId (D-N3-1: shared by authority config + membership). */
export const HUMAN_PERSON_ID = 'person_user-chris' as PersonId;

export interface MessagingV2Handle {
  /** The full embedded capability handle, held for N2+ consumers. */
  readonly embedded: EmbeddedMessaging;
  /** N2: pty presence lanes for durable agents; null without a terminal runtime. */
  readonly lanes: AgentLaneGlue | null;
  /** N3: room provisioning + the browser #team shim; null without terminals. */
  readonly rooms: RoomsGlue | null;
  /** D-N6-1: the DEC-17 door; null when disabled or when its bind failed. */
  readonly door: MessagingDoor | null;
  close(): Promise<void>;
}

/** The optional human principal (person_user-chris, role Human) from config. */
function humanConfig(humanToken: string | undefined): Omit<NovakaiAuthorityConfig, 'tokenStore'> {
  if (humanToken === undefined) return {};
  // A-R-N4-1: the owner's lane oversight is HOST policy — granted here, in
  // the app composition. The package's DEFAULT_ROLE_GRANTS is deliberately
  // unchanged so no second host silently gains oversight (DEC-07).
  return { humans: [{ token: humanToken, personId: HUMAN_PERSON_ID, roles: ['Human'], grants: ['oversight.read'] }] };
}

/** Boot-log principal count: live/spawning durable agents + configured humans. */
function countPrincipals(objectModel: ObjectModel, config: Omit<NovakaiAuthorityConfig, 'tokenStore'>): number {
  const agents = objectModel.listAgents().filter(isActiveAgent).length;
  return agents + (config.humans?.length ?? 0);
}

export interface StartMessagingV2Deps {
  objectModel: ObjectModel;
  /** Journal path; defaults to .novakai-command/messaging-v2/journal.jsonl. */
  storePath?: string;
  /** D-N6-2: agent credential issuance/resolution (REQUIRED — the authority
   * rejects every agent credential without it). */
  tokenStore: TokenStore;
  /** D-N8-1: external principals (fleet roster + policy co-membership +
   * boot-minted sync credentials). Optional — absent means no externals. */
  externalsStore?: ExternalsStore;
  /** D-N6-1: the DEC-17 door. Absent = disabled (scratch rigs); port 0 =
   * ephemeral (tests). Boot failure never kills the capability (loud log). */
  door?: DoorOptions;
  /** Human principal credential (person_user-chris, role Human). Optional —
   * unset self-mints a boot-random token that never leaves the process (the
   * app is the human session's only consumer); set only to pin it for ops. */
  humanToken?: string;
  /**
   * N2: the terminal runtime the 'pty' presence transport binds to. Absent =
   * the N1 posture (default in-memory 'ws' transport, no agent lanes).
   */
  terminals?: TerminalRuntime;
  /** N2: launch subscription hook (AgentsHub.onLaunch in the app composition). */
  onLaunch?: (listener: (info: AgentInfo) => void) => void;
  log?: (message: string) => void;
}

/** A close failure must never mask the boot failure it cleans up after. */
async function closeQuietly(embedded: EmbeddedMessaging): Promise<void> {
  try {
    await embedded.close();
  } catch {
    // The boot failure stands.
  }
}

/** Boot + announce, guarded: any failure closes the half-built capability
 * (sweep/bus timers, the journal handle) so "capability disabled this run"
 * is mechanically true (N1 audit finding 1), never a log line over a leak. */
async function bootGuarded(
  embedded: EmbeddedMessaging,
  deps: StartMessagingV2Deps,
  humanToken: string,
  config: Omit<NovakaiAuthorityConfig, 'tokenStore'>,
  storePath: string,
  transport: ReturnType<typeof createTerminalHostTransport> | null,
  directory: ReturnType<typeof createRoomDirectory>,
  doorTransport: ReturnType<typeof createDoorTransport> | null,
): Promise<MessagingV2Handle> {
  try {
    return await bootServing(embedded, deps, humanToken, config, storePath, transport, directory, doorTransport);
  } catch (error) {
    await closeQuietly(embedded);
    throw error;
  }
}

/** D-N6-2 zero-touch issuance: every active durable agent holds a token
 * before ANY consumer (lanes, the door, spawn env) can need one. The launch
 * path re-ensures per spawn (presence glue's openLane). D-N8-1: active
 * externals get the same treatment (the policy sync authenticates them). */
function bootMintTokens(deps: StartMessagingV2Deps): void {
  for (const block of deps.objectModel.listAgents().filter(isActiveAgent)) {
    deps.tokenStore.ensure(block.id);
  }
  for (const personId of deps.externalsStore?.activePersonIds() ?? []) {
    deps.tokenStore.ensureExternal(personId);
  }
}

/** The serving half of the boot: sweep, glue, announce, handle. */
async function bootServing(
  embedded: EmbeddedMessaging,
  deps: StartMessagingV2Deps,
  humanToken: string,
  config: Omit<NovakaiAuthorityConfig, 'tokenStore'>,
  storePath: string,
  transport: ReturnType<typeof createTerminalHostTransport> | null,
  directory: ReturnType<typeof createRoomDirectory>,
  doorTransport: ReturnType<typeof createDoorTransport> | null,
): Promise<MessagingV2Handle> {
  const principals = countPrincipals(deps.objectModel, config);
  // DEC-21/F10: the recovery sweep runs BEFORE serving (inside start()).
  await embedded.start();
  bootMintTokens(deps);
  const booted = await bootLanes(embedded, deps, humanToken, transport, directory);
  const door = await startDoorSafely(embedded, doorTransport, deps);
  const announce = deps.log ?? console.log;
  announce(`[messaging-v2] capability booted (store=${storePath}, principals=${principals})`);
  return serveHandle(embedded, booted, door);
}

/** D-N6-1: a door bind failure must never kill the capability — the app
 * serves without it, LOUD (the N1 boot-failure posture, one level down). */
async function startDoorSafely(
  embedded: EmbeddedMessaging,
  doorTransport: ReturnType<typeof createDoorTransport> | null,
  deps: StartMessagingV2Deps,
): Promise<MessagingDoor | null> {
  if (doorTransport === null || deps.door === undefined) return null;
  try {
    return await startDoor(embedded, doorTransport, deps.door);
  } catch (error) {
    const announce = deps.log ?? console.error;
    announce(`[messaging-v2] DOOR failed to bind (${deps.door.host ?? '127.0.0.1'}:${deps.door.port}) — externals unserved this run: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The public handle over the booted stack + glue. */
function serveHandle(
  embedded: EmbeddedMessaging,
  booted: BootedGlue | null,
  door: MessagingDoor | null,
): MessagingV2Handle {
  return {
    embedded,
    lanes: booted?.lanes ?? null,
    rooms: booted?.rooms ?? null,
    door,
    close: async () => {
      await door?.close(); // door sockets carry subscriptions — they close first
      await closeAll(embedded, booted?.lanes ?? null, booted?.rooms ?? null);
    },
  };
}

interface BootedGlue {
  lanes: AgentLaneGlue;
  rooms: RoomsGlue;
}

function makeLaneGlue(
  embedded: EmbeddedMessaging,
  deps: StartMessagingV2Deps,
  humanToken: string,
  transport: NonNullable<ReturnType<typeof createTerminalHostTransport>>,
): AgentLaneGlue {
  return createAgentLaneGlue({
    embedded,
    transport,
    terminals: deps.terminals as TerminalRuntime,
    objectModel: deps.objectModel,
    tokenStore: deps.tokenStore,
    ...(deps.externalsStore !== undefined ? { externalsStore: deps.externalsStore } : {}),
    humanToken,
    ...(deps.log !== undefined ? { 'log': deps.log } : {}),
  });
}

function makeRoomsGlue(
  embedded: EmbeddedMessaging,
  deps: StartMessagingV2Deps,
  directory: ReturnType<typeof createRoomDirectory>,
  lanes: AgentLaneGlue,
): RoomsGlue {
  return createRoomsGlue({
    embedded,
    objectModel: deps.objectModel,
    directory,
    terminals: deps.terminals as TerminalRuntime,
    humanSession: () => lanes.humanSession(),
    humanPersonId: HUMAN_PERSON_ID,
    ...(deps.log !== undefined ? { 'log': deps.log } : {}),
  });
}

/** N2/N3: open pty lanes for already-running agents, provision the rooms,
 * and wire the launch hook for both. */
async function bootLanes(
  embedded: EmbeddedMessaging,
  deps: StartMessagingV2Deps,
  humanToken: string,
  transport: ReturnType<typeof createTerminalHostTransport> | null,
  directory: ReturnType<typeof createRoomDirectory>,
): Promise<BootedGlue | null> {
  if (transport === null || deps.terminals === undefined) return null;
  const lanes = makeLaneGlue(embedded, deps, humanToken, transport);
  const rooms = makeRoomsGlue(embedded, deps, directory, lanes);
  // audit #9: subscribe launches BEFORE the boot sweep so a spawn landing
  // mid-sweep is never missed — openLane's registry-keyed idempotence
  // dedupes any overlap between the two paths.
  deps.onLaunch?.((info) => {
    lanes.handleAgentLaunched(info);
    rooms.handleAgentLaunched(info);
  });
  // FIX 6 (audit F6): rooms provision BEFORE lanes open (and before the
  // start-sweep can re-drive pending room deliveries) so the transport's
  // roomLabel lookup never misses for replayed deliveries.
  await rooms.ensureAllRooms();
  await lanes.openBootLanes();
  return { lanes, rooms };
}

async function closeAll(
  embedded: EmbeddedMessaging,
  lanes: AgentLaneGlue | null,
  rooms: RoomsGlue | null,
): Promise<void> {
  await rooms?.close();
  await lanes?.close();
  await embedded.close();
}

/** The terminal-host transport with the N3 lookups, or null without terminals. */
function makeTransport(
  deps: StartMessagingV2Deps,
  directory: ReturnType<typeof createRoomDirectory>,
): ReturnType<typeof createTerminalHostTransport> | null {
  // N2: with a terminal runtime, the ONLY registered transport is the
  // terminal-host 'pty' lane; without one, the default in-memory 'ws'
  // transport keeps the N1 posture (OpenPresence names a registered kind or
  // fails ValidationFailed — Seams §4 composition rule). N3: the transport
  // gets the rooms directory's label lookup for [nvk-room …] formatting and
  // the human's display name.
  if (deps.terminals === undefined) return null;
  return createTerminalHostTransport(deps.terminals, {
    roomLabel: (threadId) => directory.labelFor(threadId),
    senderName: (personId) => (personId === HUMAN_PERSON_ID ? CHRIS_MEMBER : undefined),
  });
}

/** The presence transports for this boot: the pty lane (with terminals) plus
 * the door's 'ws' transport (D-N6-1 — externals OpenPresence with 'ws'). */
function makeTransports(
  ptyTransport: ReturnType<typeof createTerminalHostTransport> | null,
  deps: StartMessagingV2Deps,
): { transports: PresenceTransport[]; doorTransport: ReturnType<typeof createDoorTransport> | null } {
  const doorTransport = deps.door !== undefined ? createDoorTransport() : null;
  const transports: PresenceTransport[] = [];
  if (ptyTransport !== null) transports.push(ptyTransport);
  if (doorTransport !== null) transports.push(doorTransport);
  return { transports, doorTransport };
}

/** The authority + membership adapters (pure — no resources to leak if
 * construction throws). D-N3-1: the human rides EVERY roster; D-N8-1/2: the
 * externals store feeds auth, provisioning, and the fleet roster. */
function makeAdapters(deps: StartMessagingV2Deps, clock: ReturnType<typeof createSystemClock>, config: Omit<NovakaiAuthorityConfig, 'tokenStore'>) {
  const authority = createNovakaiAuthority(deps.objectModel, clock, {
    ...config, tokenStore: deps.tokenStore,
    ...(deps.externalsStore !== undefined ? { externalsStore: deps.externalsStore } : {}),
  });
  const membership = createNovakaiMembership(
    deps.objectModel, clock, HUMAN_PERSON_ID,
    () => deps.externalsStore?.activePersonIds() ?? [],
  );
  return { authority, membership };
}

export async function startMessagingV2(deps: StartMessagingV2Deps): Promise<MessagingV2Handle> {
  const clock = createSystemClock();
  const storePath = deps.storePath ?? path.resolve('.novakai-command/messaging-v2/journal.jsonl');
  // The human principal must ALWAYS exist: the app is its only consumer
  // (server-owned routes — nothing external authenticates as the human), so an
  // ops-required env var was ceremony that 503'd #team in production (N3 live
  // verification). Unset env → self-mint a boot-random token; it never leaves
  // the process. NVK_MESSAGING_V2_HUMAN_TOKEN remains an override.
  const humanToken = deps.humanToken ?? `human_${randomUUID()}`;
  const config = humanConfig(humanToken);
  const { authority, membership } = makeAdapters(deps, clock, config);
  const store = await openJsonlStore(clock, { path: storePath });
  const directory = createRoomDirectory();
  const transport = makeTransport(deps, directory);
  const { transports, doorTransport } = makeTransports(transport, deps);
  const embedded = createEmbeddedMessaging({
    clock, store, authority, membership,
    busPollIntervalMs: 500, sweepIntervalMs: 60_000,
    ...(transports.length === 0 ? {} : { transports }),
  });
  return bootGuarded(embedded, deps, humanToken, config, storePath, transport, directory, doorTransport);
}
