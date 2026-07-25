/**
 * messagingV2 membership adapter (Messaging-Seams §3): ObjectModel-backed
 * MembershipSource for the sealed @novakai/messaging capability (slice N1).
 *
 * DEC-04: membership truth stays with ObjectModel — this adapter only
 * TRANSLATES. RoomRef authorities are "mission" and "team"; any other
 * authority string is `unknown` (UnknownRoomError, this seam's own
 * vocabulary). Roster derivation mirrors the app's single authority:
 * membership derives from durable Agent `refs` (teams.jsonl holds NO member
 * lists), filtered to status 'live' | 'spawning' — retired/failed agents
 * cannot receive, and including them would manufacture terminal delivery
 * failures on every room send.
 *
 * Linearization (§3.2, R8): NO cached rosters — every resolveMembers reads
 * ObjectModel fresh, inside the caller's accept call. Revision evidence
 * (§3.2.3): ObjectModel has no native revision token, so the adapter's
 * revision is the sha256 hex of the sorted member personId list (joined
 * with '\n') — a membership change is a revision change.
 *
 * personId derivation is shared with the authority adapter (the exported
 * personIdForAgentId from ../authority/index.js — ONE derivation, imported,
 * never duplicated) so the Person a room send targets is the Person the
 * authority authenticates.
 *
 * isMember serves READ-time authorization only (R3: GetThread/GetMessages/
 * GetDelivery/ListThreadsForPerson/subscriptions). The send path NEVER uses
 * it (§3.2.4): sender membership is decided from the same resolveMembers
 * result that freezes the acceptance snapshot.
 *
 * Failure discipline (§3.3): an ObjectModel read throwing maps to
 * `unavailable` (DependencyUnavailable{membership, retryable: true}) via the
 * seam helper — never a throw across the seam, never a silent allow/deny
 * (G6). The bounded per-call deadline is enforced by the composition root's
 * withMembershipDeadline wrapper, not here.
 */

import { createHash } from 'node:crypto';
import { MessagingError } from '../../../../packages/messaging/public/contract/index.js';
import type { PersonId } from '../../../../packages/messaging/public/contract/index.js';
import type { ClockIds } from '../../../../packages/messaging/seams/clock.js';
import { membershipUnavailable, unknownRoom } from '../../../../packages/messaging/seams/membership.js';
import type {
  IsMemberOutcome,
  MembershipSource,
  ResolveMembersOutcome,
  RoomRef,
} from '../../../../packages/messaging/seams/membership.js';
import type { AgentBlock, ObjectModel } from '../../objectModel/index.js';
import { personIdForAgentId } from '../authority/index.js';

/** The two RoomRef authorities this adapter serves (§3.1). */
const KNOWN_AUTHORITIES: ReadonlySet<string> = new Set(['mission', 'team']);

/** Receivable lifecycle states — retired/failed agents are never recipients. */
function isReceivable(block: AgentBlock): boolean {
  return block.status === 'live' || block.status === 'spawning';
}

/** §3.2.3: the authority has no native revision token — hash the sorted roster. */
function revisionFor(members: PersonId[]): string {
  const sorted = [...members].sort().join('\n');
  return createHash('sha256').update(sorted).digest('hex');
}

/** Fresh roster resolution (R8 — no cache); null when the room is unknown. */
function resolveFresh(objectModel: ObjectModel, room: RoomRef): PersonId[] | null {
  if (room.authority === 'mission') {
    if (objectModel.missionRecord(room.externalId) === null) return null;
    return objectModel
      .missionAgents(room.externalId)
      .filter(isReceivable)
      .map((block) => personIdForAgentId(block.id));
  }
  // room.authority === 'team' (checked by the callers)
  if (objectModel.teamRecord(room.externalId) === null) return null;
  return objectModel
    .listAgents()
    .filter(
      (block) =>
        isReceivable(block) &&
        block.refs?.some((reference) => reference.kind === 'team' && reference.value === room.externalId),
    )
    .map((block) => personIdForAgentId(block.id));
}

/** §3.3: a read throw is a typed dependency failure, never a leaked exception. */
function resolveSafely(objectModel: ObjectModel, room: RoomRef): PersonId[] | null | MessagingError {
  try {
    return resolveFresh(objectModel, room);
  } catch (error) {
    return membershipUnavailable(
      `membership read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function makeResolveMembers(objectModel: ObjectModel, clock: ClockIds): MembershipSource['resolveMembers'] {
  return async (room): Promise<ResolveMembersOutcome> => {
    if (!KNOWN_AUTHORITIES.has(room.authority)) return { kind: 'unknown', error: unknownRoom(room) };
    const members = resolveSafely(objectModel, room);
    if (members instanceof MessagingError) return { kind: 'unavailable', error: members };
    if (members === null) return { kind: 'unknown', error: unknownRoom(room) };
    return {
      kind: 'resolved',
      members,
      evidence: { authority: room.authority, revision: revisionFor(members), resolvedAt: clock.now() },
    };
  };
}

function makeIsMember(objectModel: ObjectModel): MembershipSource['isMember'] {
  return async (room, personId): Promise<IsMemberOutcome> => {
    if (!KNOWN_AUTHORITIES.has(room.authority)) return { kind: 'unknown', error: unknownRoom(room) };
    const members = resolveSafely(objectModel, room);
    if (members instanceof MessagingError) return { kind: 'unavailable', error: members };
    if (members === null) return { kind: 'unknown', error: unknownRoom(room) };
    return { kind: 'known', member: members.includes(personId) };
  };
}

export function createNovakaiMembership(
  objectModel: ObjectModel,
  clock: ClockIds,
): MembershipSource {
  return {
    resolveMembers: makeResolveMembers(objectModel, clock),
    isMember: makeIsMember(objectModel),
  };
}
