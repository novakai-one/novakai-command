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
 * Room Thread provisioning note (composition/coreStack.ts): passing a READY
 * MembershipSource means the coreStack provisions NOTHING — the HOST owns
 * room Thread creation. That is slice N3's job; N1 boots with zero room
 * Threads (the direct person: lane works today).
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

export interface MessagingV2Handle {
  /** The full embedded capability handle, held for N2+ consumers. */
  readonly embedded: EmbeddedMessaging;
  /** N2: pty presence lanes for durable agents; null without a terminal runtime. */
  readonly lanes: AgentLaneGlue | null;
  close(): Promise<void>;
}

/** The optional human principal (person_user-chris, role Human) from config. */
function humanConfig(humanToken: string | undefined): NovakaiAuthorityConfig {
  if (humanToken === undefined) return {};
  return { humans: [{ token: humanToken, personId: 'person_user-chris' as PersonId, roles: ['Human'] }] };
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
): Promise<MessagingV2Handle> {
  try {
    const principals = countPrincipals(deps.objectModel, config);
    // DEC-21/F10: the recovery sweep runs BEFORE serving (inside start()).
    await embedded.start();
    const lanes = await bootLanes(embedded, deps, transport);
    const announce = deps.log ?? console.log;
    announce(`[messaging-v2] capability booted (store=${storePath}, principals=${principals})`);
    return { embedded, lanes, close: () => closeAll(embedded, lanes) };
  } catch (error) {
    await closeQuietly(embedded);
    throw error;
  }
}

/** N2: open pty lanes for already-running agents and wire the launch hook. */
async function bootLanes(
  embedded: EmbeddedMessaging,
  deps: StartMessagingV2Deps,
  transport: ReturnType<typeof createTerminalHostTransport> | null,
): Promise<AgentLaneGlue | null> {
  if (transport === null || deps.terminals === undefined) return null;
  const lanes = createAgentLaneGlue({ embedded, transport, terminals: deps.terminals, 'log': deps.log });
  await lanes.openBootLanes();
  deps.onLaunch?.((info) => lanes.handleAgentLaunched(info));
  return lanes;
}

async function closeAll(embedded: EmbeddedMessaging, lanes: AgentLaneGlue | null): Promise<void> {
  await lanes?.close();
  await embedded.close();
}

export async function startMessagingV2(deps: StartMessagingV2Deps): Promise<MessagingV2Handle> {
  const clock = createSystemClock();
  const storePath = deps.storePath ?? path.resolve('.novakai-command/messaging-v2/journal.jsonl');
  const config = humanConfig(deps.humanToken);
  // Pure adapters first — no resources to leak if construction throws.
  const authority = createNovakaiAuthority(deps.objectModel, clock, config);
  const membership = createNovakaiMembership(deps.objectModel, clock);
  const store = await openJsonlStore(clock, { path: storePath });
  // N2: with a terminal runtime, the ONLY registered transport is the
  // terminal-host 'pty' lane; without one, the default in-memory 'ws'
  // transport keeps the N1 posture (OpenPresence names a registered kind or
  // fails ValidationFailed — Seams §4 composition rule).
  const transport = deps.terminals === undefined ? null : createTerminalHostTransport(deps.terminals);
  const embedded = createEmbeddedMessaging({
    clock, store, authority, membership,
    busPollIntervalMs: 500, sweepIntervalMs: 60_000,
    ...(transport === null ? {} : { transports: [transport] }),
  });
  return bootGuarded(embedded, deps, config, storePath, transport);
}
