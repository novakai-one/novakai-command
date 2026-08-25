/**
 * Authority seam — Messaging-Seams.md §2.
 *
 * Authenticates principals and vends verified grants. The core NEVER takes
 * identity or grants from caller data (DEC-11, G3) and NEVER knows what a
 * "role" is (DEC-07 amendment — the role→grant mapping lives in adapter
 * configuration, §2.3, never in core).
 *
 * Grants are snapshotted at authentication and held for the session; a grant
 * change mid-session takes effect at the next `revalidate` (§2.1). The
 * degraded-state ruling is §2.1: `revalidate → unavailable` does NOT end the
 * session — new operations fail with DependencyUnavailable{authority,
 * retryable: true} until a revalidate succeeds; past the grace period the
 * session is treated as invalid. The session wrapper (core/session.ts)
 * implements that state machine against THIS seam.
 *
 * Provisioning directory (adjunct, not part of §2.1): MSG-014 requires
 * `UnknownRecipient` when an address does not resolve to a provisioned Person.
 * §2.1 defines no provisioning-resolution operation, so the directory is a
 * sibling interface on the same trust boundary (the Identity authority owns
 * provisioning; the v1 adapter answers from its config). The core consumes
 * the boolean; it never sees the directory's contents.
 */

import { MessagingError } from "../schemas.js";
import type { Grant, PersonId, Timestamp } from "../schemas.js";

/** The authenticated caller (§2.1). The ONLY sender identity source. */
export interface Principal {
  personId: PersonId;
  /** Verified at authentication, session-scoped. The core checks booleans only (R10). */
  grants: Grant[];
  /** Runtime handle for invalidation — never a durable ref (G2). */
  sessionId: string;
  expiresAt: Timestamp;
}

export type AuthOutcome =
  | { kind: "authenticated"; principal: Principal }
  /** Bad/expired/unknown credential — public NotAuthenticated. */
  | { kind: "rejected"; error: MessagingError }
  /** Authority down — public DependencyUnavailable{authority, retryable: true}. */
  | { kind: "unavailable"; error: MessagingError };

export type RevalidateOutcome =
  | { kind: "valid"; principal: Principal }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export interface Authority {
  authenticate(credential: unknown): Promise<AuthOutcome>;
  revalidate(sessionId: string): Promise<RevalidateOutcome>;
}

/**
 * Provisioning lookup (see header note). Answers "is this Person provisioned
 * with the Identity authority?" — the MSG-014 UnknownRecipient check.
 */
export interface ProvisioningDirectory {
  isProvisioned(personId: PersonId): Promise<boolean>;
}

/** §2.2 failure constructors — one place, reused by every authority adapter. */
export function authRejected(detail: string): MessagingError {
  return new MessagingError("NotAuthenticated", {
    message: `authentication rejected: ${detail}`,
    retryable: false,
    fields: {},
  });
}

export function authUnavailable(detail: string): MessagingError {
  return new MessagingError("DependencyUnavailable", {
    message: `authority dependency failure: ${detail}`,
    retryable: true,
    fields: { dependency: "authority", retryable: true },
  });
}
