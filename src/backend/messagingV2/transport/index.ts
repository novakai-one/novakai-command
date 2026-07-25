/**
 * messagingV2 terminal-host presence transport (slice N2 — Agent direct lane):
 * the package's PresenceTransport seam (Messaging-Seams §4) implemented over
 * the app's TerminalRuntime submit lane. One Presence binds to one durable
 * agentId; the ADDRESSED lane (deliver) types `[nvk-msg from <name> id <id>]`
 * into the recipient's lane through the host-owned timed submission (D2).
 *
 * EFFECT HONESTY (audit #3): `{kind:'effect'}` here means exactly "accepted
 * into the live per-agent host lane (submit() returned true)" — the type →
 * settle → \r lifecycle then runs asynchronously under the PTY-owning
 * process. It is NOT a claim of "bytes into the PTY": a PTY death inside the
 * settle window loses the queued job silently (runSubmission's quiet no-op).
 * That loss window is bounded by liveness — onExit → onDisconnect → the
 * Delivery stays pending and the presence closes (R5/R9) — and matches the
 * WS adapter's "frame onto the socket" standard (Seams §4: the effect is the
 * hand-off to the socket/lane, never end-to-end receipt). There is
 * deliberately NO transcript confirmer on this lane: the old confirmer dies
 * in N5, and delivery truth is the transport's (DEC-08/G10).
 *
 * The OBSERVATION lane (push) is an honest no-op on a live lane: PTY agents
 * consume addressed deliveries, not subscription frames.
 *
 * Bind discipline mirrors presence-transport-pty (§4.3): binding is
 * adapter-owned (bind), an unbound lane is a TRANSIENT failure (the
 * open→retrigger→bind window, retried inside the R5 budget), and a lane
 * whose agent exited reports permanent "presence-gone" — never an effect
 * against a corpse. Liveness is REPORTED, never inferred by the core: the
 * runtime's onExit raises onDisconnect for every Presence bound to that
 * agentId, funnelling into the core's single presence-close path (R9).
 *
 * Submission timings mirror the old PtyDelivery DEFAULT_TIMINGS
 * (src/backend/messaging/delivery/index.ts): 900 ms settle before the
 * submit \r; an urgent (interrupt) delivery leads with Esc + 400 ms settle
 * INSIDE the host lane (C2 — it can never clear a prior job's mid-settle
 * input); the 6 s flush \r is kimi-only (the proven swallowed-\r bug).
 */

import type { PresenceId } from '../../../../packages/messaging/public/contract/index.js';
import type { Message } from '../../../../packages/messaging/public/contract/index.js';
import type {
  DeliverPayload,
  EffectReport,
  PresenceTransport,
  TransportLivenessCallbacks,
} from '../../../../packages/messaging/seams/presenceTransport.js';
import type { SubmitJob } from '../../terminal/host/protocol/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';

/** settleMs before the submit \r (old DEFAULT_TIMINGS.submitDelayMs). */
const SUBMIT_SETTLE_MS = 900;
/** settleMs after an interrupt's Esc (old DEFAULT_TIMINGS.interruptSettleMs). */
const INTERRUPT_SETTLE_MS = 400;
/** kimi-only flush \r delay (old DEFAULT_TIMINGS.flushDelayMs). */
const KIMI_FLUSH_MS = 6_000;

export interface TerminalHostPresenceTransport extends PresenceTransport {
  /**
   * Bind a minted Presence to a live terminal lane. Returns false when the
   * agent has no running PTY (the spawn→bind window) — the caller MUST then
   * close the minted Presence through the core's single close path.
   */
  bind(presenceId: PresenceId, agentId: string): boolean;
  /** Bound lanes (operability/tests). */
  readonly boundCount: number;
}

interface TransportState {
  runtime: TerminalRuntime;
  bindings: Map<PresenceId, string>;
  liveness?: TransportLivenessCallbacks;
  /** N3: threadId → room label lookup (the rooms directory fills it). */
  roomLabel?: (threadId: string) => string | undefined;
  /** N3: non-agent principal display names (the human → 'chris'). */
  senderName?: (personId: string) => string | undefined;
}

function transient(detail: string): EffectReport {
  // Unbound ≠ gone (the bind window): retried inside the R5 budget.
  return { kind: 'failure', retryable: true, detail };
}

function presenceGone(detail: string): EffectReport {
  // The lane died — the presence closes, the Delivery stays pending (R5).
  return { kind: 'failure', retryable: false, detail, permanent: 'presence-gone' };
}

/**
 * personId → agentId candidates: the inverse of authority's
 * personIdForAgentId (`person_${agentId.replaceAll('_', '-')}`). Both dash
 * foldings are tried because the fold is lossy — `agent_<uuid>` ids carry
 * real dashes (only their first underscore folded), while synthetic ids like
 * `agent_ops_team_lead` folded every underscore (audit #8).
 * REVERSE-MAPPING IS DEBT: the authority documents the mapping as
 * one-directional; the right fix is an authority-owned personId→name query
 * (later slice). Until then, roster-match both candidates.
 */
function agentIdCandidates(personId: string): string[] {
  if (!personId.startsWith('person_agent-')) return [];
  const suffix = personId.slice('person_'.length);
  return [suffix.replaceAll('-', '_'), suffix.replace('-', '_')];
}

/** One delivery line: direct stays `[nvk-msg …]`; a provisioned room thread
 * (N3, D3 receive convention) becomes `[nvk-room <label> from …]`. Raw
 * newlines would submit the TUI early, so they become literal "\n". */
function deliveryText(displayName: string, message: Message, roomLabel: string | undefined): string {
  const oneLine = message.body.text.replace(/\r?\n/g, '\\n');
  if (roomLabel !== undefined) {
    return `[nvk-room ${roomLabel} from ${displayName} id ${message.id}] ${oneLine}`;
  }
  return `[nvk-msg from ${displayName} id ${message.id}] ${oneLine}`;
}

function liveInfo(runtime: TerminalRuntime, agentId: string): AgentInfo | undefined {
  const info = runtime.list().find((agent) => agent.agentId === agentId);
  return info?.status === 'running' ? info : undefined;
}

/** The D2 host-lane job: urgent leads with Esc inside the serialized lane;
 * the flush \r rides only for kimi (mirrors old DEFAULT_TIMINGS). */
function submitJobFor(info: AgentInfo, payload: DeliverPayload, text: string): SubmitJob {
  const urgent = payload.priority === 'urgent';
  return {
    agentId: info.agentId,
    messageId: payload.message.id,
    text,
    settleMs: SUBMIT_SETTLE_MS,
    ...(info.provider === 'kimi' ? { flushMs: KIMI_FLUSH_MS } : {}),
    ...(urgent ? { leadIn: { data: '\x1b', settleMs: INTERRUPT_SETTLE_MS } } : {}),
  };
}

function displayNameFor(state: TransportState, senderId: string): string {
  const named = state.senderName?.(senderId);
  if (named !== undefined) return named;
  const roster = state.runtime.list();
  for (const candidate of agentIdCandidates(senderId)) {
    const title = roster.find((agent) => agent.agentId === candidate)?.title;
    if (title !== undefined) return title;
  }
  return senderId;
}

function laneState(state: TransportState, presenceId: PresenceId): { info: AgentInfo } | EffectReport {
  const agentId = state.bindings.get(presenceId);
  if (agentId === undefined) {
    return transient(`no terminal lane bound to ${presenceId} (bind window or unbound)`);
  }
  const info = liveInfo(state.runtime, agentId);
  if (info === undefined) {
    return presenceGone(`no live terminal for ${agentId} — the connection died`);
  }
  return { info };
}

function deliverMessage(state: TransportState, presenceId: PresenceId, payload: DeliverPayload): Promise<EffectReport> {
  const lane = laneState(state, presenceId);
  if (!('info' in lane)) return Promise.resolve(lane);
  const text = deliveryText(
    displayNameFor(state, payload.message.senderId),
    payload.message,
    state.roomLabel?.(payload.message.threadId),
  );
  if (state.runtime.submit(submitJobFor(lane.info, payload, text))) {
    return Promise.resolve({ kind: 'effect' }); // bytes queued into a live lane (G10)
  }
  // Acceptance-only refusal: the lane died between the check and the submit,
  // or the PTY is otherwise unwritable — re-read the truth.
  return Promise.resolve(
    liveInfo(state.runtime, lane.info.agentId) === undefined
      ? presenceGone(`submit refused for ${lane.info.agentId} — the lane is gone`)
      : transient(`submit refused for ${lane.info.agentId} (no live PTY lane)`),
  );
}

function pushFrame(state: TransportState, presenceId: PresenceId): Promise<EffectReport> {
  // OBSERVATION lane: PTY agents don't consume subscription frames — the
  // addressed lane is their only intake. An honest no-op on a live lane;
  // liveness honesty still applies (never an "effect" against a corpse).
  const lane = laneState(state, presenceId);
  if (!('info' in lane)) return Promise.resolve(lane);
  return Promise.resolve({ kind: 'effect' });
}

/** Liveness is reported (§4.1): a terminal exit disconnects every Presence
 * bound to that agentId through the core's single close path (R9). */
function onAgentExit(state: TransportState, agentId: string): void {
  for (const [presenceId, boundAgentId] of [...state.bindings]) {
    if (boundAgentId !== agentId) continue;
    state.bindings.delete(presenceId);
    state.liveness?.onDisconnect(presenceId);
  }
}

function bindLane(state: TransportState, presenceId: PresenceId, agentId: string): boolean {
  if (liveInfo(state.runtime, agentId) === undefined) return false; // spawn→bind window
  state.bindings.set(presenceId, agentId);
  return true;
}

function transportFront(state: TransportState): TerminalHostPresenceTransport {
  return {
    kind: 'pty',
    get boundCount(): number {
      return state.bindings.size;
    },
    attachLiveness(callbacks: TransportLivenessCallbacks): void {
      state.liveness = callbacks;
    },
    bind: (presenceId, agentId) => bindLane(state, presenceId, agentId),
    deliver: (presenceId, payload) => deliverMessage(state, presenceId, payload),
    push: (presenceId) => pushFrame(state, presenceId),
  };
}

export function createTerminalHostTransport(
  runtime: TerminalRuntime,
  options?: {
    roomLabel?: (threadId: string) => string | undefined;
    senderName?: (personId: string) => string | undefined;
  },
): TerminalHostPresenceTransport {
  const state: TransportState = {
    runtime,
    bindings: new Map(),
    ...(options?.roomLabel !== undefined ? { roomLabel: options.roomLabel } : {}),
    ...(options?.senderName !== undefined ? { senderName: options.senderName } : {}),
  };
  runtime.onExit((agentId) => onAgentExit(state, agentId));
  return transportFront(state);
}
