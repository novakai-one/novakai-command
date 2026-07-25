/**
 * Session — wraps an authenticated Principal with the §2.1 revalidation
 * state machine. Every command/query crosses `run`, which enforces:
 *
 *   active   → operations proceed. A lazy revalidation fires when the session
 *              has passed expiresAt (the composition root owns revalidation in
 *              every integration mode; in embedded mode there is no protocol
 *              adapter to lean on, so the trigger is evaluated here, at the
 *              same clock the authority used — deterministic under clock-seeded).
 *   degraded → revalidate returned `unavailable`: invalidity cannot be proven,
 *              so the session is NOT ended (§2.1 — cutting push during a
 *              transient authority outage would recreate the polling failure).
 *              The Presence stays open; every new operation fails with
 *              DependencyUnavailable{authority, retryable: true}. Past the
 *              grace period (adapter config, v1 default 5 min) the session is
 *              treated as invalid.
 *   ended    → revalidate returned `invalid` (or grace elapsed): every
 *              operation fails NotAuthenticated, subscriptions end with
 *              ended{auth-lost} via onEnded. TERMINAL (F3): no transition
 *              out, ever — a later `valid` revalidation must NOT resurrect
 *              the session; a dead session is replaced by re-authenticating.
 *
 * Grants are snapshotted at authentication and refreshed only by a successful
 * revalidate (§2.1) — run() hands operations the CURRENT snapshot.
 *
 * Grace is CLOCK-DRIVEN (F3): the grace check runs on the revalidation path
 * itself, not only when a new operation crosses the guard — so the
 * composition's revalidation timer ends an idle degraded session past grace
 * (and fires onEnded) instead of letting subscriptions flow indefinitely.
 */

import { MessagingError } from "../public/contract/index.js";
import type { ClockIds } from "../seams/clock.js";
import type { Authority, Principal } from "../seams/authority.js";

export const DEFAULT_REVALIDATE_GRACE_MS = 300_000;

export type SessionState = "active" | "degraded" | "ended";

/** The door's outcome shape: typed outcomes, never leaked exceptions. */
export type Outcome<T> = { kind: "ok"; value: T } | { kind: "error"; error: MessagingError };

export interface MessagingSessionCore {
  readonly state: SessionState;
  readonly principal: Principal;
  /** Explicit revalidation trigger (composition-root owned, §2.1). Returns the resulting state. */
  revalidate(): Promise<SessionState>;
  /** Wrap one operation with the session guard + typed-error conversion. */
  run<T>(operation: (principal: Principal) => Promise<T>): Promise<Outcome<T>>;
}

export interface SessionDeps {
  authority: Authority;
  clock: ClockIds;
  graceMs?: number;
  /**
   * §2.1: revalidate returning invalid TERMINATES live subscriptions with
   * ended{auth-lost}. The session owns the invalidity decision; the
   * composition root wires this hook to the subscription manager. Called at
   * most once, on the transition into "ended" from ANY path (explicit
   * revalidate, lazy expiry, grace elapse).
   */
  onEnded?: () => void;
}

function notAuthenticated(detail: string): MessagingError {
  return new MessagingError("NotAuthenticated", {
    message: detail,
    retryable: false,
    fields: {},
  });
}

function authorityDegraded(): MessagingError {
  return new MessagingError("DependencyUnavailable", {
    message: "authority revalidation is unavailable — session degraded (§2.1); retry after the authority recovers",
    retryable: true,
    fields: { dependency: "authority", retryable: true },
  });
}

export function createSession(initial: Principal, deps: SessionDeps): MessagingSessionCore {
  const { authority, clock } = deps;
  const graceMs = deps.graceMs ?? DEFAULT_REVALIDATE_GRACE_MS;

  let state: SessionState = "active";
  let principal = initial;
  let degradedSinceMs: number | undefined;
  let endedNotified = false;

  const nowMs = (): number => Date.parse(clock.now());
  const expiresAtMs = (): number => Date.parse(principal.expiresAt);

  /** The single ended-transition notification (§2.1 → ended{auth-lost} wiring). */
  function markEnded(): void {
    state = "ended";
    degradedSinceMs = undefined;
    if (!endedNotified) {
      endedNotified = true;
      deps.onEnded?.();
    }
  }

  async function doRevalidate(): Promise<SessionState> {
    // F3: ended is TERMINAL — no revalidation outcome ever transitions out.
    if (state === "ended") return state;
    const outcome = await authority.revalidate(principal.sessionId);
    switch (outcome.kind) {
      case "valid":
        principal = outcome.principal; // fresh grants take effect HERE (§2.1)
        state = "active";
        degradedSinceMs = undefined;
        break;
      case "invalid":
        markEnded();
        break;
      case "unavailable":
        if (state !== "degraded") degradedSinceMs = nowMs();
        state = "degraded";
        // F3: grace is clock-driven — enforced on the revalidation path too,
        // not only in guard(). An idle degraded session whose authority stays
        // down past grace ENDS here (the revalidation timer drives this) and
        // fires onEnded — subscriptions stop flowing at the grace boundary.
        if (nowMs() - (degradedSinceMs as number) >= graceMs) {
          markEnded();
        }
        break;
    }
    return state;
  }

  /** The guard every operation crosses. Returns the blocking error, if any. */
  async function guard(): Promise<MessagingError | undefined> {
    if (state === "ended") {
      return notAuthenticated("session is no longer valid (revalidate returned invalid)");
    }
    if (state === "active" && nowMs() >= expiresAtMs()) {
      // Lazy expiry revalidation — the embedded-mode revalidation trigger (§2.1).
      const next = await doRevalidate();
      if (next === "ended") {
        return notAuthenticated("session expired and revalidation returned invalid");
      }
    }
    if (state === "degraded") {
      const since = degradedSinceMs ?? nowMs();
      if (nowMs() - since >= graceMs) {
        markEnded(); // grace elapsed → treated as invalid (§2.1)
        return notAuthenticated("authority unavailable past the grace period — session treated as invalid");
      }
      return authorityDegraded();
    }
    return undefined;
  }

  return {
    get state() {
      return state;
    },
    get principal() {
      return principal;
    },

    async revalidate(): Promise<SessionState> {
      return doRevalidate();
    },

    async run<T>(operation: (principal: Principal) => Promise<T>): Promise<Outcome<T>> {
      const blocked = await guard();
      if (blocked) return { kind: "error", error: blocked };
      try {
        return { kind: "ok", value: await operation(principal) };
      } catch (cause) {
        if (cause instanceof MessagingError) return { kind: "error", error: cause };
        // A non-MessagingError throw is a core bug — rethrow rather than
        // launder it into a wrong typed error (G6 honesty cuts both ways).
        throw cause;
      }
    },
  };
}
