/**
 * membership-config adapter (Messaging-Seams.md §3.4): config-driven
 * room/roster source for v1 — the membership analogue of authority-config.
 * The room/roster truth is CONFIGURATION HERE, never core (mirroring the
 * DEC-07 placement of the role→grant mapping): changing a roster = editing
 * one config. The real per-capability adapters (`membership-novakai`) land
 * with the Team/Mission capabilities; this adapter satisfies the full §3.1
 * contract for embedded mode and tests.
 *
 * Revision evidence (§3.2.3): a config file has no native revision token, so
 * the adapter computes `revision = sha256 hex of the sorted member list` —
 * a constant roster yields a constant revision, and a roster change yields a
 * new one. Revisions are authority-scoped evidence, never compared across
 * adapters or authorities (§3.2.3).
 *
 * Room Thread provisioning (Store-Seam §11.4): the configured rooms are the
 * composition root's provisioning source — `configuredRooms()` is an
 * adapter-private extra (like ConfigAuthority's test controls), not seam
 * surface; the root creates each room's Thread at startup via the store's
 * createRoomThread (get-or-create — restart-safe).
 *
 * Deadline (§3.3): enforced by the coreStack `withMembershipDeadline`
 * wrapper (trivially met here — the adapter is in-process). `setUnavailable`
 * models the external authority's failure state so the G6 honesty paths
 * (send fails DependencyUnavailable, never a stale roster) are exercisable.
 *
 * Room-key hygiene (F8): authority/externalId join into the durable room key
 * (`authority\nexternalId`, here and at the store seam §11.4) — control
 * characters in either half are rejected fail-fast at construction, so
 * distinct rooms can never collide onto one key.
 */

import { createHash } from "node:crypto";
import { idPatterns } from "../public/contract/index.js";
import type { MembershipEvidence, PersonId } from "../public/contract/index.js";
import type { ClockIds } from "../seams/clock.js";
import { membershipUnavailable, unknownRoom } from "../seams/membership.js";
import type {
  IsMemberOutcome,
  MembershipSource,
  ResolveMembersOutcome,
  RoomRef,
} from "../seams/membership.js";

// --- configuration (the roster truth lives HERE, never in core) ----------------

export interface MembershipRoomConfig {
  threadKind: "team" | "mission";
  /** Name of the external membership authority this room belongs to. */
  authority: string;
  /** The room's ID in that authority (with authority, the durable room key). */
  externalId: string;
  /** The room's current members (roster truth for v1). */
  members: PersonId[];
}

export interface MembershipConfig {
  rooms: MembershipRoomConfig[];
}

export interface ConfigMembership extends MembershipSource {
  /** Adapter-private extra: the composition root's §11.4 provisioning source. */
  configuredRooms(): readonly MembershipRoomConfig[];
  /** Test/host control: simulate the membership authority being unreachable (§3.3). */
  setUnavailable(unavailable: boolean): void;
}

const PERSON_PATTERN = new RegExp(idPatterns.PersonId);
const roomKey = (room: RoomRef): string => `${room.authority}\n${room.externalId}`;
/**
 * The room key joins authority/externalId on "\n" (and the store seam's room
 * index does the same, Store-Seam §11.4) — control characters in either half
 * would collide distinct rooms onto one key. Rejected fail-fast at this
 * construction boundary (F8): config carrying them never becomes an adapter.
 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/** §3.2.3 fallback revision: hash of the sorted member list (adapter-private encoding). */
function revisionFor(members: readonly PersonId[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...members].sort()))
    .digest("hex");
}

export function createConfigMembership(
  config: MembershipConfig,
  clock: ClockIds,
): ConfigMembership {
  // Fail-fast config validation at construction (Seams §1: an adapter that
  // cannot meet its seam's obligations must not be registered).
  const byKey = new Map<string, MembershipRoomConfig>();
  for (const room of config.rooms) {
    if (room.threadKind !== "team" && room.threadKind !== "mission") {
      throw membershipUnavailable(
        `room ${JSON.stringify(room.externalId)} has invalid threadKind ${JSON.stringify(room.threadKind)}`,
      );
    }
    if (room.authority.length === 0 || room.externalId.length === 0) {
      throw membershipUnavailable("room authority and externalId must be non-empty");
    }
    if (CONTROL_CHAR_PATTERN.test(room.authority) || CONTROL_CHAR_PATTERN.test(room.externalId)) {
      throw membershipUnavailable(
        `room ${JSON.stringify(room.externalId)} carries control characters in authority/externalId — they would collide the room key (F8)`,
      );
    }
    const key = roomKey(room);
    if (byKey.has(key)) {
      throw membershipUnavailable(`duplicate room key ${JSON.stringify(key)} in membership config`);
    }
    const seen = new Set<string>();
    for (const member of room.members) {
      if (!PERSON_PATTERN.test(member)) {
        throw membershipUnavailable(`member ${JSON.stringify(member)} fails the PersonId pattern`);
      }
      if (seen.has(member)) {
        throw membershipUnavailable(`duplicate member ${member} in room ${JSON.stringify(key)}`);
      }
      seen.add(member);
    }
    byKey.set(key, room);
  }

  let unavailable = false;

  return {
    configuredRooms(): readonly MembershipRoomConfig[] {
      return config.rooms;
    },
    setUnavailable(flag: boolean): void {
      unavailable = flag;
    },

    async resolveMembers(room: RoomRef): Promise<ResolveMembersOutcome> {
      if (unavailable) {
        return { kind: "unavailable", error: membershipUnavailable("membership authority is unavailable") };
      }
      const found = byKey.get(roomKey(room));
      if (!found) return { kind: "unknown", error: unknownRoom(room) };
      const evidence: MembershipEvidence = {
        authority: found.authority,
        revision: revisionFor(found.members),
        resolvedAt: clock.now(),
      };
      return { kind: "resolved", members: [...found.members], evidence };
    },

    async isMember(room: RoomRef, personId: PersonId): Promise<IsMemberOutcome> {
      if (unavailable) {
        return { kind: "unavailable", error: membershipUnavailable("membership authority is unavailable") };
      }
      const found = byKey.get(roomKey(room));
      if (!found) return { kind: "unknown", error: unknownRoom(room) };
      return { kind: "known", member: found.members.includes(personId) };
    },
  };
}
