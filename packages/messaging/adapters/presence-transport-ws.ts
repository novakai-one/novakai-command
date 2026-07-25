/**
 * presence-transport-ws adapter (Messaging-Seams.md §4.3) — the real
 * WebSocket presence transport over `ws` (DEC-17 standalone mode). Satisfies
 * the full §4.1 seam: `deliver` (ADDRESSED lane — the only honest source of
 * "delivered", G10/DEC-08), `push` (OBSERVATION lane — subscription frames,
 * never touches Delivery state), and liveness reporting into the core's
 * single presence-close path (R9).
 *
 * Mechanics (adapter-private, §4.1 "the core sees one contract"):
 *  - effect = the frame was handed to the socket and ws confirmed the write
 *    (send callback without error) — a REAL transport effect. A bounded
 *    effect deadline (v1 default 5 s, §4.3) turns a hung write into a
 *    transient failure, never a hung caller.
 *  - A socket that is not OPEN reports permanent "presence-gone" (§4.1: the
 *    connection died — the presence closes, the Delivery stays pending).
 *  - Liveness is ws ping/pong (the transport's own probe, §4.1): each
 *    connection must answer a ping within one interval; a missed pong raises
 *    onLivenessTimeout and the socket is terminated. A socket close raises
 *    onDisconnect for every Presence bound to it. Both callbacks funnel into
 *    the core's single presence-close path — the adapter never touches
 *    presence state itself.
 *
 * Binding (adapter-owned, beyond the seam): the protocol layer calls
 * `bind(presenceId, socket)` after OpenPresence mints the Presence — the
 * seam routes by presenceId, so the adapter owns the presenceId → socket
 * table. One socket may carry several Presences (duplicate opens, R9); a
 * socket close reports every one of them. bind returns false when the
 * socket is already untracked (F10: it died in the accept→bind window) —
 * the protocol layer then closes the minted Presence through the core's
 * single close path; a silently-dropped bind would leak a ghost Presence.
 *
 * Wire shapes: the SubscriptionMessage crosses `push` verbatim (contract
 * stream shape); `deliver` wraps the payload in the DEC-17 DeliveryFrame
 * (protocol/frames.ts — the inbound protocol's shared wire types; import
 * direction is adapter → protocol types only, never adapter → adapter).
 */

import { WebSocket } from "ws";
import type { PresenceId, SubscriptionMessage } from "../public/contract/index.js";
import type { DeliveryFrame } from "../protocol/frames.js";
import type {
  DeliverPayload,
  EffectReport,
  PresenceTransport,
  TransportLivenessCallbacks,
} from "../seams/presenceTransport.js";

export interface WsPresenceTransportOptions {
  /** Liveness probe cadence (default 30 s): ping every interval; a missed pong closes. */
  livenessIntervalMs?: number;
  /** Bounded effect deadline (default 5 s, §4.3). */
  effectDeadlineMs?: number;
}

export interface WsPresenceTransport extends PresenceTransport {
  /** Register a freshly-accepted socket (unbound until OpenPresence → bind). */
  accept(socket: WebSocket): void;
  /** Bind a minted Presence to a socket (protocol layer, post-OpenPresence). Returns false when the socket is already gone (F10). */
  bind(presenceId: PresenceId, socket: WebSocket): boolean;
  /** Graceful shutdown: close every tracked socket; liveness stops. */
  closeAll(): Promise<void>;
  /** Count of tracked sockets (operability/tests). */
  readonly socketCount: number;
}

interface TrackedSocket {
  socket: WebSocket;
  /** Presences bound to this socket (duplicate opens share one connection, R9). */
  presences: Set<PresenceId>;
  /** Answered the last ping (liveness probe bookkeeping). */
  alive: boolean;
}

export function createWsPresenceTransport(options?: WsPresenceTransportOptions): WsPresenceTransport {
  const livenessIntervalMs = options?.livenessIntervalMs ?? 30_000;
  const effectDeadlineMs = options?.effectDeadlineMs ?? 5_000;

  const tracked = new Map<WebSocket, TrackedSocket>();
  const byPresence = new Map<PresenceId, WebSocket>();
  let liveness: TransportLivenessCallbacks | undefined;
  let livenessTimer: NodeJS.Timeout | undefined;

  function untrack(socket: WebSocket): void {
    const entry = tracked.get(socket);
    if (entry === undefined) return;
    tracked.delete(socket);
    for (const presenceId of entry.presences) {
      byPresence.delete(presenceId);
      // The single presence-close path (R9) — the core closes, ends
      // subscriptions, emits the PresenceChanged observation.
      liveness?.onDisconnect(presenceId);
    }
    entry.presences.clear();
  }

  function sendPayload(socket: WebSocket, payload: unknown): Promise<EffectReport> {
    return new Promise((resolve) => {
      if (socket.readyState !== WebSocket.OPEN) {
        resolve({
          kind: "failure",
          retryable: false,
          detail: "socket is not OPEN — the connection is gone",
          permanent: "presence-gone",
        });
        return;
      }
      let settled = false;
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        // §4.3 bounded effect deadline: a hung write is a transient failure,
        // never a hung caller.
        resolve({ kind: "failure", retryable: true, detail: "effect deadline exceeded" });
      }, effectDeadlineMs);
      socket.send(JSON.stringify(payload), (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) {
          resolve({
            kind: "failure",
            retryable: socket.readyState === WebSocket.OPEN,
            detail: `ws send failed: ${error.message}`,
            ...(socket.readyState !== WebSocket.OPEN
              ? { permanent: "presence-gone" as const }
              : {}),
          });
        } else {
          // The frame is on the wire — a REAL effect (G10/DEC-08).
          resolve({ kind: "effect" });
        }
      });
    });
  }

  function startLiveness(): void {
    if (livenessTimer !== undefined || livenessIntervalMs <= 0) return;
    livenessTimer = setInterval(() => {
      for (const entry of [...tracked.values()]) {
        if (!entry.alive) {
          // Missed a whole interval: the probe failed — report, terminate,
          // and let untrack raise onDisconnect for the bound Presences.
          for (const presenceId of entry.presences) {
            liveness?.onLivenessTimeout(presenceId);
          }
          entry.socket.terminate();
          untrack(entry.socket);
          continue;
        }
        entry.alive = false;
        entry.socket.ping();
      }
    }, livenessIntervalMs);
    livenessTimer.unref?.();
  }

  return {
    kind: "ws",

    get socketCount(): number {
      return tracked.size;
    },

    attachLiveness(callbacks: TransportLivenessCallbacks): void {
      liveness = callbacks;
      startLiveness();
    },

    accept(socket: WebSocket): void {
      const entry: TrackedSocket = { socket, presences: new Set(), alive: true };
      tracked.set(socket, entry);
      socket.on("pong", () => {
        entry.alive = true;
      });
      socket.on("close", () => {
        untrack(socket);
      });
    },

    bind(presenceId: PresenceId, socket: WebSocket): boolean {
      const entry = tracked.get(socket);
      // F10: unknown socket — the close path already ran (accept→bind
      // window). The caller MUST close the minted Presence through the
      // single close path; silently returning leaked a ghost Presence.
      if (entry === undefined) return false;
      entry.presences.add(presenceId);
      byPresence.set(presenceId, socket);
      return true;
    },

    async deliver(presenceId: PresenceId, payload: DeliverPayload): Promise<EffectReport> {
      const socket = byPresence.get(presenceId);
      if (socket === undefined) {
        // No socket bound (yet). This is NOT "presence-gone": a real
        // disconnect arrives via untrack → onDisconnect (the single close
        // path), and a bound socket that died mid-effect reports
        // presence-gone from the readyState check in sendPayload. A live
        // Presence with no bound socket is the open→retrigger→bind window
        // (the registry's opened-listeners fire before the protocol layer
        // can bind) — a TRANSIENT failure, retried inside the R5 budget.
        return {
          kind: "failure",
          retryable: true,
          detail: `no socket bound to ${presenceId} (bind window or unbound)`,
        };
      }
      const frame: DeliveryFrame = {
        kind: "delivery",
        message: payload.message,
        priority: payload.priority,
        presenceId,
      };
      return sendPayload(socket, frame);
    },

    async push(presenceId: PresenceId, frame: SubscriptionMessage): Promise<EffectReport> {
      const socket = byPresence.get(presenceId);
      if (socket === undefined) {
        // As deliver: unbound ≠ gone (see the note there). For the push lane
        // a transient report parks the frame in the subscription buffer.
        return {
          kind: "failure",
          retryable: true,
          detail: `no socket bound to ${presenceId} (bind window or unbound)`,
        };
      }
      // OBSERVATION lane (R2): the SubscriptionMessage crosses verbatim.
      return sendPayload(socket, frame);
    },

    async closeAll(): Promise<void> {
      if (livenessTimer !== undefined) {
        clearInterval(livenessTimer);
        livenessTimer = undefined;
      }
      const sockets = [...tracked.keys()];
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.readyState === WebSocket.CLOSED) {
                untrack(socket);
                resolve();
                return;
              }
              const guard = setTimeout(() => {
                socket.terminate();
                untrack(socket);
                resolve();
              }, 1_000);
              socket.once("close", () => {
                clearTimeout(guard);
                resolve();
              });
              socket.close(1001, "server shutdown");
            }),
        ),
      );
    },
  };
}
