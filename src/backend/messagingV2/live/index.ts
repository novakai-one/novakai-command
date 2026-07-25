/**
 * messagingV2 live dialect (slice N4 — Frontend, D-N4-1): the browser is a
 * forwarded-frame subscriber over the EXISTING app ws. A client sends
 * `{type:'messaging-v2-sub', since?}` on /ws; the server creates a
 * PER-CONNECTION subscription as the human session (embedded sinks may be
 * unbound — no browser presence transport, recorded as the N5/N6 option)
 * and forwards every frame verbatim as `{event:'messaging-v2', payload}` to
 * THAT socket. Sink honesty: a successful write is {kind:'effect'}; a dead
 * socket is a PERMANENT failure (the subscription ends — the client
 * refetches and resubscribes from its persisted cursor). Teardown is
 * MANUAL (subscriptions.ts): the handle closes on socket close.
 *
 * At-least-once delivery is the contract — the client dedupes by global
 * journal sequence and resumes from its persisted cursor on reconnect.
 */

import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import type { Cursor } from '../../../../packages/messaging/public/contract/index.js';
import type { SubscriptionHandle } from '../../../../packages/messaging/core/subscriptions.js';
import type { EffectReport } from '../../../../packages/messaging/seams/presenceTransport.js';

/** The slice of a ws socket the sink needs (structural — tests fake it). */
export interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
}

const SOCKET_OPEN = 1;

export interface MessagingLiveDeps {
  /** The held human session (null until the capability boots). */
  humanSession: () => MessagingSession | null;
  log?: (message: string) => void;
}

export interface MessagingLive {
  /** Handle one `{type:'messaging-v2-sub', since?}` frame for this socket. */
  subscribe(socket: LiveSocket, since: string | undefined): Promise<void>;
  /** Manual teardown on socket close (idempotent). */
  close(socket: LiveSocket): void;
  /** Live per-connection subscriptions (operability/tests). */
  readonly count: number;
}

function announce(deps: MessagingLiveDeps, message: string): void {
  (deps.log ?? ((): void => {}))(message);
}

/** The forwarded-frame sink: write ok → effect; dead socket → permanent
 * failure so the subscription ends instead of buffering into a corpse. */
function socketSink(socket: LiveSocket): (frame: unknown) => Promise<EffectReport> {
  return (frame) => {
    try {
      if (socket.readyState !== SOCKET_OPEN) {
        return Promise.resolve({ kind: 'failure', retryable: false, detail: 'socket is not open' });
      }
      socket.send(JSON.stringify({ event: 'messaging-v2', payload: frame }));
      return Promise.resolve({ kind: 'effect' });
    } catch (cause) {
      return Promise.resolve({
        kind: 'failure',
        retryable: false,
        detail: `socket write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  };
}

/** Honest dependency loss — the client refetches and resubscribes. */
function dependencyLost(socket: LiveSocket): void {
  try {
    socket.send(JSON.stringify({
      event: 'messaging-v2',
      payload: { kind: 'ended', subscriptionId: 'unavailable', reason: 'dependency-lost' },
    }));
  } catch {
    // the socket is already gone — nothing to report into
  }
}

interface LiveState {
  deps: MessagingLiveDeps;
  handles: Map<LiveSocket, SubscriptionHandle>;
}

/** Supersede the socket's prior handle BEFORE replacing it (F6 — every
 * event would land twice otherwise). */
async function supersede(state: LiveState, socket: LiveSocket, handle: SubscriptionHandle): Promise<void> {
  const existing = state.handles.get(socket);
  if (existing !== undefined) await existing.close().catch(() => {});
  state.handles.set(socket, handle);
}

async function subscribeSocket(state: LiveState, socket: LiveSocket, since: string | undefined): Promise<void> {
  const session = state.deps.humanSession();
  if (session === null) {
    dependencyLost(socket);
    return;
  }
  const outcome = await session.subscribe(
    { events: ['MessageCommitted', 'DeliveryUpdated', 'PresenceChanged'], ...(since !== undefined ? { since: since as Cursor } : {}) },
    socketSink(socket),
  );
  if (outcome.kind !== 'ok') {
    announce(state.deps, `[messaging-v2] live subscribe failed (${outcome.error.name}): ${outcome.error.message}`);
    return;
  }
  if (socket.readyState !== SOCKET_OPEN) {
    // Dead-on-arrival: the subscription already ended on the failed
    // started-flush — close the handle instead of leaking a zombie.
    await outcome.value.close().catch(() => {});
    return;
  }
  await supersede(state, socket, outcome.value);
}

function closeSocket(state: LiveState, socket: LiveSocket): void {
  const handle = state.handles.get(socket);
  if (handle === undefined) return;
  state.handles.delete(socket);
  void handle.close().catch(() => {
    // Teardown is best-effort; the socket is already gone.
  });
}

export function createMessagingLive(deps: MessagingLiveDeps): MessagingLive {
  const state: LiveState = { deps, handles: new Map() };
  return {
    subscribe: (socket, since) => subscribeSocket(state, socket, since),
    close: (socket) => closeSocket(state, socket),
    get count(): number {
      return state.handles.size;
    },
  };
}
