/**
 * messagingV2 presence glue (slice N2 — Agent direct lane): opens and binds
 * the 'pty' presence lane for every durable agent and takes over the spawn
 * briefing from the old MessagingHub.handleAgentSpawned (deleted).
 *
 * Lane lifecycle: authenticate({ token: agentId }) → openPresence({ transport:
 * 'pty', clientLabel: agentId }) → transport.bind(presenceId, agentId). The
 * authority rejects agents without a durable record (plain spawns) — they get
 * no lane, and their briefing says messaging is unavailable. Lanes open on
 * launch AND at boot for already-running live agents (PTYs survive backend
 * restarts; presence is ephemeral, DEC-02); any surviving registry presences
 * with a clientLabel are re-bound to their live terminals first. Sessions are
 * held for the app lifetime and dropped on close (the embedded stack's own
 * close ends them — the in-memory registry dies with it).
 *
 * Briefing: same 3000 ms delay and roster re-check as the old hub, but
 * delivered through the TerminalRuntime submit lane directly (the old
 * PtyDelivery path is untouched but no longer used for briefings).
 *
 * D-N2-5 (team contact bootstrap): after every boot/launch lane-open, the
 * glue runs the membership-driven contact-policy sync (../policy/index.ts)
 * for every held session — host policy, composition-owned, core untouched.
 */

import type { EmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import type { ObjectModel } from '../../objectModel/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { composeAgentBriefing } from '../briefing/index.js';
import { personIdForAgentId } from '../authority/index.js';
import { createContactBootstrap } from '../policy/index.js';
import type { ContactBootstrap } from '../policy/index.js';
import type { TerminalHostPresenceTransport } from '../transport/index.js';

const BRIEFING_DELAY_MS = 3_000;
const BRIEFING_SETTLE_MS = 900;
const KIMI_FLUSH_MS = 6_000;

export interface AgentLaneGlueDeps {
  embedded: EmbeddedMessaging;
  transport: TerminalHostPresenceTransport;
  terminals: TerminalRuntime;
  /** D-N2-5: durable membership truth for the team contact bootstrap. */
  objectModel: ObjectModel;
  /** When set, the human principal's session is held and its allowlist seeded. */
  humanToken?: string;
  /** Test hook; defaults to 3000 ms (the old hub's delay). */
  briefingDelayMs?: number;
  log?: (message: string) => void;
}

export interface AgentLaneGlue {
  /** Boot: re-bind registry survivors, then open lanes for running agents. */
  openBootLanes(): Promise<void>;
  /** onLaunch handler: open the lane, then schedule the spawn briefing. */
  handleAgentLaunched(info: AgentInfo): void;
  /** Open lanes (operability/tests). */
  laneCount(): number;
  /** The held human session (N3: the rooms glue posts/reads #team as Chris). */
  humanSession(): MessagingSession | null;
  close(): Promise<void>;
}

interface GlueState {
  deps: AgentLaneGlueDeps;
  sessions: Map<string, MessagingSession>;
  timers: Set<NodeJS.Timeout>;
  /** The held human session (D-N2-5); null until ensured or unconfigured. */
  human: MessagingSession | null;
  bootstrap: ContactBootstrap;
}

/** Authenticate the human principal once and hold the session (D-N2-5). */
async function ensureHuman(state: GlueState): Promise<void> {
  if (state.human !== null || state.deps.humanToken === undefined) return;
  const auth = await state.deps.embedded.authenticate({ token: state.deps.humanToken });
  state.human = auth.kind === 'authenticated' ? auth.session : null;
}

/** D-N2-5: membership-driven contact bootstrap — best-effort host policy;
 * a policy write must never break a lane. Failures are logged, never thrown. */
async function syncPolicies(state: GlueState): Promise<void> {
  if (state.sessions.size === 0 && state.human === null) return;
  const failures = await state.bootstrap.sync(state.sessions, state.human);
  const announce = state.deps.log ?? ((): void => {});
  for (const failure of failures) {
    announce(`[messaging-v2] contact-policy sync failed for ${failure.personId}: ${failure.detail}`);
  }
}

/** audit #6: a sync-level throw (e.g. the membership read itself) is logged,
 * never propagated — policy is host policy, never a lane or boot gate. */
async function syncPoliciesSafely(state: GlueState): Promise<void> {
  try {
    await syncPolicies(state);
  } catch (cause) {
    const announce = state.deps.log ?? ((): void => {});
    const detail = cause instanceof Error ? cause.message : String(cause);
    announce(`[messaging-v2] contact-policy sync failed: ${detail}`);
  }
}

/** Re-bind surviving registry presences (clientLabel = agentId) to live terminals. */
function rebindSurvivors(state: GlueState): void {
  for (const presence of state.deps.embedded.registry.all()) {
    if (presence.transport !== 'pty' || presence.clientLabel === undefined) continue;
    state.deps.transport.bind(presence.id, presence.clientLabel);
  }
}

/** authenticate → openPresence → bind. False = no lane (plain spawn etc.).
 * Idempotence keys off the REGISTRY, not the held sessions: an agent whose
 * presence closed (liveness, R9) and who relaunches with the same durable
 * agentId must get a fresh presence — a stale session must not suppress it. */
async function openLane(state: GlueState, agentId: string): Promise<boolean> {
  if (state.deps.embedded.registry.presencesFor(personIdForAgentId(agentId)).length > 0) return true;
  const auth = await state.deps.embedded.authenticate({ token: agentId });
  if (auth.kind !== 'authenticated') return false;
  const opened = await auth.session.openPresence({ transport: 'pty', clientLabel: agentId });
  if (opened.kind !== 'ok') return false;
  if (!state.deps.transport.bind(opened.value.presenceId, agentId)) {
    await auth.session.closePresence({ presenceId: opened.value.presenceId });
    return false;
  }
  state.sessions.set(agentId, auth.session);
  return true;
}

async function openBootLanes(state: GlueState): Promise<void> {
  await ensureHuman(state);
  rebindSurvivors(state);
  const running = state.deps.terminals.list().filter((info) => info.status === 'running');
  let opened = 0;
  for (const info of running) {
    if (await openLane(state, info.agentId)) opened += 1;
  }
  await syncPoliciesSafely(state);
  const announce = state.deps.log ?? ((): void => {});
  announce(`[messaging-v2] pty lanes open for ${opened}/${running.length} live agents`);
}

/** The delayed briefing: roster re-check, then the submit lane (never PtyDelivery). */
function briefAgent(state: GlueState, info: AgentInfo, messagingAvailable: boolean): void {
  const roster = state.deps.terminals.list().filter((agent) => agent.status === 'running');
  const self = roster.find((agent) => agent.agentId === info.agentId);
  if (self === undefined) return; // exited before the briefing was due
  const peers = roster
    .filter((agent) => agent.agentId !== info.agentId)
    .map((agent) => ({ name: agent.title, provider: agent.provider }));
  state.deps.terminals.submit({
    agentId: info.agentId,
    messageId: `briefing_${info.agentId}_${Date.now()}`,
    text: composeAgentBriefing({ name: self.title, peers, messagingAvailable }),
    settleMs: BRIEFING_SETTLE_MS,
    ...(self.provider === 'kimi' ? { flushMs: KIMI_FLUSH_MS } : {}),
  });
}

/** Lane first, then the D-N2-5 policy pass (a new teammate becomes reachable
 * BY existing members and vice versa before the briefing lands). audit #6:
 * a policy failure must NOT reject the lane promise or flip the briefing —
 * the lane being open is what gates the briefing. */
async function laneThenSync(state: GlueState, agentId: string): Promise<boolean> {
  const opened = await openLane(state, agentId);
  if (opened) await syncPoliciesSafely(state);
  return opened;
}

function handleAgentLaunched(state: GlueState, info: AgentInfo): void {
  const available = laneThenSync(state, info.agentId).catch(() => false);
  const delayMs = state.deps.briefingDelayMs ?? BRIEFING_DELAY_MS;
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    void available.then((messagingAvailable) => briefAgent(state, info, messagingAvailable));
  }, delayMs);
  timer.unref?.();
  state.timers.add(timer);
}

function closeGlue(state: GlueState): Promise<void> {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  state.sessions.clear();
  return Promise.resolve();
}

export function createAgentLaneGlue(deps: AgentLaneGlueDeps): AgentLaneGlue {
  const state: GlueState = {
    deps,
    sessions: new Map(),
    timers: new Set(),
    human: null,
    bootstrap: createContactBootstrap(deps.objectModel),
  };
  return {
    openBootLanes: () => openBootLanes(state),
    handleAgentLaunched: (info) => handleAgentLaunched(state, info),
    laneCount: () => state.sessions.size,
    humanSession: () => state.human,
    close: () => closeGlue(state),
  };
}
