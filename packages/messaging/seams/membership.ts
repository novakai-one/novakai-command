/**
 * Membership seam — Messaging-Seams.md §3.
 *
 * Resolves team/mission membership for Room Threads. Membership truth stays
 * with its owning capability (DEC-04); Messaging resolves it at this seam and
 * freezes what it used (I5): `resolveMembers` returns the authority's
 * `revision`, which enters `AcceptanceInput.snapshot.membership` and is
 * committed atomically with the recipient set (Store-Seam §9).
 *
 * Linearization (§3.2, R8):
 *  - No cached rosters: every room send resolves membership FRESH inside the
 *    accept call, immediately before commitAcceptance. The resolution-to-commit
 *    window is small but non-zero; honesty comes from RECORDING the revision
 *    that was used, not from pretending the window is zero (§3.2.1/2).
 *  - R4 SENDER membership is decided from the SAME `resolveMembers` result
 *    that freezes the snapshot — `sender ∈ members` inside the acceptance
 *    step. A separate `isMember` call at send time would be a second
 *    resolution against a potentially different revision — exactly what R8
 *    forbids (§3.2.4). `isMember` serves READ-time authorization only (R3:
 *    GetThread/GetMessages/GetDelivery/ListThreadsForPerson/subscriptions).
 *  - Revisions are authority-scoped evidence, never a protocol: an authority
 *    without a native revision token is adapted by `revision = <hash of the
 *    sorted member list>` computed by the adapter (§3.2.3).
 *
 * Failure vocabulary (§3.3): `UnknownRoom` is THIS seam's own vocabulary —
 * distinct from the store seam's RecordNotFound; the public mapping
 * (`UnknownThread`, send and read) is shared. `unavailable` maps to
 * DependencyUnavailable{dependency: "membership", retryable: true} — never a
 * silent allow or deny (G6): a room send whose membership cannot be resolved
 * FAILS the send; it never falls back to a stale or partial roster (I5's
 * snapshot must be true). Bounded deadline per call (§3.3, v1 default 3 s):
 * enforced by the `withMembershipDeadline` wrapper below, applied ONCE in
 * the composition root (coreStack) — adapters themselves need no timer.
 */

import { MessagingError } from "../public/contract/index.js";
import type { MembershipEvidence, PersonId } from "../public/contract/index.js";

/** The room reference a Room Thread carries (contract Thread.room). */
export interface RoomRef {
  /** Name of the external membership authority (Team or Mission capability). */
  authority: string;
  /** The room's ID in that authority. */
  externalId: string;
}

/**
 * §3.1/§3.3 — this seam's own vocabulary: the room is unknown to the
 * membership authority. Distinct from the store seam's RecordNotFound; the
 * core maps it to public UnknownThread (send and read).
 */
export interface UnknownRoomError {
  name: "UnknownRoom";
  authority: string;
  externalId: string;
}

export type ResolveMembersOutcome =
  | { kind: "resolved"; members: PersonId[]; evidence: MembershipEvidence }
  | { kind: "unknown"; error: UnknownRoomError }
  /** → public DependencyUnavailable{dependency: "membership", retryable: true}. */
  | { kind: "unavailable"; error: MessagingError };

export type IsMemberOutcome =
  | { kind: "known"; member: boolean }
  | { kind: "unknown"; error: UnknownRoomError }
  | { kind: "unavailable"; error: MessagingError };

export interface MembershipSource {
  /** §3.1 — fresh resolution with revision evidence (R8). */
  resolveMembers(room: RoomRef): Promise<ResolveMembersOutcome>;
  /** §3.1 — read-time authorization only (R3); NEVER the send path (§3.2.4). */
  isMember(room: RoomRef, personId: PersonId): Promise<IsMemberOutcome>;
}

/** §3.3 failure constructors — one place, reused by every membership adapter. */
export function unknownRoom(room: RoomRef): UnknownRoomError {
  return { name: "UnknownRoom", authority: room.authority, externalId: room.externalId };
}

export function membershipUnavailable(detail: string): MessagingError {
  return new MessagingError("DependencyUnavailable", {
    message: `membership dependency failure: ${detail}`,
    retryable: true,
    fields: { dependency: "membership", retryable: true },
  });
}

/** §3.3: the bounded per-call deadline (v1 default 3 s). */
export const DEFAULT_MEMBERSHIP_DEADLINE_MS = 3_000;

/**
 * §3.3 deadline enforcement — ONE wrapper around the seam, applied by the
 * composition root (coreStack) so every caller (send path, read-time R3,
 * subscriptions) gets the bounded-deadline guarantee and no adapter can hang
 * a caller. A deadline breach is `unavailable` →
 * DependencyUnavailable{dependency: "membership", retryable: true} — never a
 * hung caller, never a silent allow/deny (G6). The underlying call is not
 * cancelled (in-process adapters settle on their own; a real network
 * adapter's own timeout is its business) — the wrapper only bounds the WAIT.
 */
export function withMembershipDeadline(
  source: MembershipSource,
  deadlineMs: number = DEFAULT_MEMBERSHIP_DEADLINE_MS,
): MembershipSource {
  function deadlineError(): MessagingError {
    return membershipUnavailable(
      `membership call exceeded the bounded ${deadlineMs} ms deadline (Seams §3.3)`,
    );
  }
  return {
    resolveMembers(room: RoomRef): Promise<ResolveMembersOutcome> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ kind: "unavailable", error: deadlineError() });
        }, deadlineMs);
        timer.unref?.();
        void source.resolveMembers(room).then(
          (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
          },
          (cause: unknown) => {
            // An adapter THROW is a dependency failure (typed), never an
            // exception escaping the seam.
            clearTimeout(timer);
            resolve({
              kind: "unavailable",
              error: membershipUnavailable(
                `membership adapter threw: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            });
          },
        );
      });
    },
    isMember(room: RoomRef, personId: PersonId): Promise<IsMemberOutcome> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ kind: "unavailable", error: deadlineError() });
        }, deadlineMs);
        timer.unref?.();
        void source.isMember(room, personId).then(
          (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
          },
          (cause: unknown) => {
            clearTimeout(timer);
            resolve({
              kind: "unavailable",
              error: membershipUnavailable(
                `membership adapter threw: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            });
          },
        );
      });
    },
  };
}
