/**
 * Presence-transport seam — Messaging-Seams.md §4.
 *
 * Produces the actual delivery effect to a live runtime (DEC-08) — the ONLY
 * place "delivered" can honestly come from (G10, I11) — and reports connection
 * liveness into the core (R9).
 *
 * Two lanes, two operations (§4.1): `deliver` serves the ADDRESSED lane (one
 * call per attempted Delivery; its `effect` report is the only legal input to
 * pending → delivered, R5); `push` serves the OBSERVATION lane (subscription
 * frames; a push outcome NEVER touches Delivery state). S1-b wires the
 * addressed lane; `push` is part of the frozen seam and is implemented by
 * adapters now, consumed by the subscription pusher in S1-c/S3.
 *
 * Failure vocabulary (§4.2): transport failures surface through the DELIVERY
 * lane as typed state — never as command errors, and deliberately NOT via
 * DependencyUnavailable.
 *
 * Liveness is reported, not inferred: the core runs no liveness heuristics
 * (Plan §3 non-goal). Each transport MUST raise onDisconnect /
 * onLivenessTimeout; both funnel into the single presence-close path (R9).
 */

import type { PresenceId, Priority, TransportKind } from "../public/contract/index.js";
import type { Message, SubscriptionMessage } from "../public/contract/index.js";

export interface DeliverPayload {
  message: Message;
  priority: Priority;
}

export type EffectReport =
  /** Bytes into the PTY / frame onto the socket — REAL (G10). */
  | { kind: "effect" }
  /**
   * retryable: transient → R5 retry budget; non-retryable →
   * failed{transport-failure}. permanent "presence-gone": the connection died
   * mid-effect — attempt records failure, the presence closes, the Delivery
   * stays pending (R5 no-presence rule).
   */
  | { kind: "failure"; retryable: boolean; detail: string; permanent?: "presence-gone" };

/** Inbound callbacks the adapter MUST raise into the core (§4.1). */
export interface TransportLivenessCallbacks {
  /** Connection lost. */
  onDisconnect(presenceId: PresenceId): void;
  /** Transport-level liveness probe failed. */
  onLivenessTimeout(presenceId: PresenceId): void;
}

export interface PresenceTransport {
  readonly kind: TransportKind;
  /** ADDRESSED lane: one call per attempted Delivery (§4.1). */
  deliver(presenceId: PresenceId, payload: DeliverPayload): Promise<EffectReport>;
  /** OBSERVATION lane: subscription frames; never touches Delivery state (§4.1). */
  push(presenceId: PresenceId, frame: SubscriptionMessage): Promise<EffectReport>;
  /** The composition root registers the core's liveness callbacks here. */
  attachLiveness(callbacks: TransportLivenessCallbacks): void;
}

// --- retry budget (R5: "the adapter's bounded retry budget — adapter config") ---

/** Bounded retry budget for the addressed lane (R5; v1 default 5 attempts with backoff). */
export interface RetryPolicy {
  /** Total attempts including the first (v1 default 5). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/** Injectable scheduler so retries are deterministic under test clocks. */
export interface Scheduler {
  /**
   * Schedule a task; returns a cancellation handle (L7). A scheduled task
   * that outlives what it serves (subscription ended, Delivery settled) must
   * be cancellable, and production schedulers must be unref'd so a parked
   * timer never holds the process open.
   */
  schedule(delayMs: number, task: () => void): () => void;
}

export const systemScheduler: Scheduler = {
  schedule(delayMs: number, task: () => void): () => void {
    // L7: unref'd — a parked retry must never keep the process alive.
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
