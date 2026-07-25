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
import { createEmbeddedMessaging } from '../../../packages/messaging/composition/embedded.js';
import type { EmbeddedMessaging } from '../../../packages/messaging/composition/embedded.js';
import { createSystemClock } from '../../../packages/messaging/adapters/clock-system.js';
import { openJsonlStore } from '../../../packages/messaging/adapters/store-jsonl.js';
import type { PersonId } from '../../../packages/messaging/public/contract/index.js';
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

/** The one human personId (D-N3-1: shared by authority config + membership). */
export const HUMAN_PERSON_ID = 'person_user-chris' as PersonId;

export interface MessagingV2Handle {
  /** The full embedded capability handle, held for N2+ consumers. */
  readonly embedded: EmbeddedMessaging;
  /** N2: pty presence lanes for durable agents; null without a terminal runtime. */
  readonly lanes: AgentLaneGlue | null;
  /** N3: room provisioning + the browser #team shim; null without terminals. */
  readonly rooms: RoomsGlue | null;
  close(): Promise<void>;
}

/** The optional human principal (person_user-chris, role Human) from config. */
function humanConfig(humanToken: string | undefined): NovakaiAuthorityConfig {
  if (humanToken === undefined) return {};
  return { humans: [{ token: humanToken, personId: HUMAN_PERSON_ID, roles: ['Human'] }] };
}

/** Boot-log principal count: live/spawning durable agents + configured humans. */
function countPrincipals(objectModel: ObjectModel, config: NovakaiAuthorityConfig): number {
  const agents = objectModel.listAgents().filter(isActiveAgent).length;
  return agents + (config.humans?.length ?? 0);
}

export interface StartMessagingV2Deps {
  objectModel: ObjectModel;
  /** Journal path; defaults to .novakai-command/messaging-v2/journal.jsonl. */
  storePath?: string;
  /** When set, provisions the human principal (person_user-chris, role Human). */
  humanToken?: string;
  /**
   * N2: the terminal runtime the 'pty' presence transport binds to. Absent =
   * the N1 posture (default in-memory 'ws' transport, no agent lanes).
   */
  terminals?: TerminalRuntime;
  /** N2: launch subscription hook (AgentsHub.onLaunch in the app composition). */
  onLaunch?: (listener: (info: AgentInfo) => void) => void;
  /** N3: ws broadcast for the rooms live shim (browser #team lane). */
  broadcast?: (event: string, payload: unknown) => void;
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
  config: NovakaiAuthorityConfig,
  storePath: string,
  transport: ReturnType<typeof createTerminalHostTransport> | null,
  directory: ReturnType<typeof createRoomDirectory>,
): Promise<MessagingV2Handle> {
  try {
    const principals = countPrincipals(deps.objectModel, config);
    // DEC-21/F10: the recovery sweep runs BEFORE serving (inside start()).
    await embedded.start();
    const booted = await bootLanes(embedded, deps, transport, directory);
    const announce = deps.log ?? console.log;
    announce(`[messaging-v2] capability booted (store=${storePath}, principals=${principals})`);
    return {
      embedded,
      lanes: booted?.lanes ?? null,
      rooms: booted?.rooms ?? null,
      close: () => closeAll(embedded, booted?.lanes ?? null, booted?.rooms ?? null),
    };
  } catch (error) {
    await closeQuietly(embedded);
    throw error;
  }
}

interface BootedGlue {
  lanes: AgentLaneGlue;
  rooms: RoomsGlue;
}

/** N2/N3: open pty lanes for already-running agents, provision the rooms,
 * and wire the launch hook for both. */
async function bootLanes(
  embedded: EmbeddedMessaging,
  deps: StartMessagingV2Deps,
  transport: ReturnType<typeof createTerminalHostTransport> | null,
  directory: ReturnType<typeof createRoomDirectory>,
): Promise<BootedGlue | null> {
  if (transport === null || deps.terminals === undefined) return null;
  const lanes = createAgentLaneGlue({
    embedded,
    transport,
    terminals: deps.terminals,
    objectModel: deps.objectModel,
    ...(deps.humanToken !== undefined ? { humanToken: deps.humanToken } : {}),
    ...(deps.log !== undefined ? { 'log': deps.log } : {}),
  });
  const rooms = createRoomsGlue({
    embedded,
    objectModel: deps.objectModel,
    directory,
    terminals: deps.terminals,
    humanSession: () => lanes.humanSession(),
    humanPersonId: HUMAN_PERSON_ID,
    ...(deps.broadcast !== undefined ? { broadcast: deps.broadcast } : {}),
    ...(deps.log !== undefined ? { 'log': deps.log } : {}),
  });
  // audit #9: subscribe launches BEFORE the boot sweep so a spawn landing
  // mid-sweep is never missed — openLane's registry-keyed idempotence
  // dedupes any overlap between the two paths.
  deps.onLaunch?.((info) => {
    lanes.handleAgentLaunched(info);
    rooms.handleAgentLaunched(info);
  });
  await lanes.openBootLanes();
  await rooms.ensureAllRooms();
  rooms.startLiveBroadcast();
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

export async function startMessagingV2(deps: StartMessagingV2Deps): Promise<MessagingV2Handle> {
  const clock = createSystemClock();
  const storePath = deps.storePath ?? path.resolve('.novakai-command/messaging-v2/journal.jsonl');
  const config = humanConfig(deps.humanToken);
  // Pure adapters first — no resources to leak if construction throws.
  const authority = createNovakaiAuthority(deps.objectModel, clock, config);
  // D-N3-1: the human principal rides EVERY roster the membership adapter serves.
  const membership = createNovakaiMembership(
    deps.objectModel,
    clock,
    deps.humanToken === undefined ? undefined : HUMAN_PERSON_ID,
  );
  const store = await openJsonlStore(clock, { path: storePath });
  // N2: with a terminal runtime, the ONLY registered transport is the
  // terminal-host 'pty' lane; without one, the default in-memory 'ws'
  // transport keeps the N1 posture (OpenPresence names a registered kind or
  // fails ValidationFailed — Seams §4 composition rule). N3: the transport
  // gets the rooms directory's label lookup for [nvk-room …] formatting.
  const directory = createRoomDirectory();
  const transport = deps.terminals === undefined
    ? null
    : createTerminalHostTransport(deps.terminals, { roomLabel: (threadId) => directory.labelFor(threadId) });
  const embedded = createEmbeddedMessaging({
    clock, store, authority, membership,
    busPollIntervalMs: 500, sweepIntervalMs: 60_000,
    ...(transport === null ? {} : { transports: [transport] }),
  });
  return bootGuarded(embedded, deps, config, storePath, transport, directory);
}
