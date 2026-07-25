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
 * Browser #team shim (D-N3-3/4, dies in N4): the human principal posts and
 * reads #team through the capability; envelopes are translated to the OLD
 * tunnel shape tunnelModel expects. Old messages.jsonl #team history is
 * archive — NEVER merged (D1). LIVE: a human-session subscription to
 * MessageCommitted re-broadcasts translated envelopes as 'message-envelope'
 * so the browser lane updates live; a subscription failure logs and the
 * browser falls back to refetch — it never breaks the capability.
 */

import { randomUUID } from 'node:crypto';
import type { EmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import type { Message, ThreadId } from '../../../../packages/messaging/public/contract/index.js';
import type { SubscriptionHandle } from '../../../../packages/messaging/core/subscriptions.js';
import { CHRIS_MEMBER } from '../../messaging/types.js';
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
  fleetThreadId(): ThreadId | undefined;
}

export function createRoomDirectory(): RoomDirectory {
  const byThreadId = new Map<string, string>();
  const byKey = new Map<string, ThreadId>();
  return {
    register(threadId, authority, externalId, label) {
      byThreadId.set(threadId, label);
      byKey.set(`${authority}/${externalId}`, threadId);
    },
    labelFor: (threadId) => byThreadId.get(threadId),
    threadIdFor: (authority, externalId) => byKey.get(`${authority}/${externalId}`),
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
  /** ws broadcast for the live shim; absent = reads/post only. */
  broadcast?: (event: string, payload: unknown) => void;
  log?: (message: string) => void;
}

/** The old tunnel envelope shape tunnelModel consumes (dies in N4). */
export interface TranslatedEnvelope {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  status: 'delivered';
  delivery: 'normal';
}

export interface RoomsGlue {
  ensureAllRooms(): Promise<void>;
  /** Launch-time provisioning: the launched agent's team/mission rooms. */
  handleAgentLaunched(info: AgentInfo): void;
  /** D-N3-3: the human's #team post through the capability. */
  post(body: string): Promise<TranslatedEnvelope>;
  /** D-N3-4: translated #team history (old shape; archive never merged). */
  history(): Promise<TranslatedEnvelope[]>;
  threadIdFor(authority: string, externalId: string): ThreadId | undefined;
  fleetThreadId(): ThreadId | undefined;
  labelFor(threadId: string): string | undefined;
  startLiveBroadcast(): void;
  close(): Promise<void>;
}

function announce(deps: RoomsGlueDeps, message: string): void {
  (deps.log ?? ((): void => {}))(message);
}

/** senderId → display name: the human is 'chris'; agents resolve by the
 * EXACT forward derivation (personIdForAgentId) against the live roster. */
function nameFor(deps: RoomsGlueDeps, personId: string): string {
  if (personId === deps.humanPersonId) return CHRIS_MEMBER;
  const found = deps.terminals.list().find((agent) => personIdForAgentId(agent.agentId) === personId);
  return found?.title ?? personId;
}

function translate(deps: RoomsGlueDeps, message: Message): TranslatedEnvelope {
  const label = deps.directory.labelFor(message.threadId) ?? FLEET_LABEL;
  return {
    id: message.id,
    from: nameFor(deps, message.senderId),
    'to': label,
    body: message.body.text,
    createdAt: message.createdAt,
    status: 'delivered',
    delivery: 'normal',
  };
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

async function postTeam(deps: RoomsGlueDeps, body: string): Promise<TranslatedEnvelope> {
  const session = deps.humanSession();
  const threadId = deps.directory.fleetThreadId();
  if (session === null || threadId === undefined) {
    throw new Error('messaging capability unavailable this run — #team post not sent');
  }
  const accepted = await session.sendMessage({
    address: `thread:${threadId}`,
    body: { text: body },
    priority: 'normal',
    clientMessageId: `msg_${randomUUID()}`,
  });
  if (accepted.kind !== 'ok') throw new Error(accepted.error.message);
  const page = await session.getMessages({ threadId });
  const message = page.kind === 'ok' ? page.value.messages.find((entry) => entry.id === accepted.value.messageId) : undefined;
  return translate(deps, message ?? syntheticMessage(accepted.value.messageId, threadId, session, body));
}

/** The acceptance carries no Message record; synthesize one for translation
 * only when the journal read somehow misses it (never in practice). */
function syntheticMessage(messageId: string, threadId: ThreadId, session: MessagingSession, body: string): Message {
  return {
    id: messageId,
    threadId,
    senderId: session.principal.personId,
    createdAt: new Date().toISOString(),
    body: { text: body },
  } as unknown as Message;
}

async function teamHistory(deps: RoomsGlueDeps): Promise<TranslatedEnvelope[]> {
  const session = deps.humanSession();
  const threadId = deps.directory.fleetThreadId();
  if (session === null || threadId === undefined) {
    throw new Error('messaging capability unavailable this run — #team history unavailable');
  }
  const page = await session.getMessages({ threadId });
  if (page.kind !== 'ok') throw new Error(page.error.message);
  return page.value.messages.map((message) => translate(deps, message));
}

/** D-N3-4 LIVE: re-broadcast provisioned-room commits as old-shape envelopes. */
async function subscribeRooms(deps: RoomsGlueDeps, subscription: { current?: SubscriptionHandle }): Promise<void> {
  const session = deps.humanSession();
  if (session === null || deps.broadcast === undefined) return;
  const broadcast = deps.broadcast;
  const outcome = await session.subscribe({ events: ['MessageCommitted'] }, (frame) => {
    const message = frame.kind === 'event' ? (frame.event as { message?: Message }).message : undefined;
    if (message !== undefined && deps.directory.labelFor(message.threadId) !== undefined) {
      broadcast('message-envelope', translate(deps, message));
    }
    return Promise.resolve({ kind: 'effect' as const });
  });
  if (outcome.kind === 'ok') subscription.current = outcome.value;
  else announce(deps, `[messaging-v2] rooms live subscription failed (${outcome.error.name}) — browser falls back to refetch`);
}

export function createRoomsGlue(deps: RoomsGlueDeps): RoomsGlue {
  const subscription: { current?: SubscriptionHandle } = {};
  return {
    ensureAllRooms: () => ensureAllRooms(deps),
    handleAgentLaunched(info) {
      void ensureForAgent(deps, info.agentId).catch((cause: unknown) => {
        announce(deps, `[messaging-v2] launch-time room provisioning failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    },
    post: (body) => postTeam(deps, body),
    history: () => teamHistory(deps),
    threadIdFor: (authority, externalId) => deps.directory.threadIdFor(authority, externalId),
    fleetThreadId: () => deps.directory.fleetThreadId(),
    labelFor: (threadId) => deps.directory.labelFor(threadId),
    startLiveBroadcast() {
      void subscribeRooms(deps, subscription).catch((cause: unknown) => {
        announce(deps, `[messaging-v2] rooms live subscription error: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    },
    close: () => subscription.current?.close() ?? Promise.resolve(),
  };
}
