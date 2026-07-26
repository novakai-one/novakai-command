/**
 * messagingV2 membership adapter (Messaging-Seams §3): ObjectModel-backed
 * MembershipSource for the sealed @novakai/messaging capability (slice N1).
 *
 * DEC-04: membership truth stays with ObjectModel — this adapter only
 * TRANSLATES. RoomRef authorities are "mission", "team", and (D-N3-1)
 * "fleet"; any other authority string is `unknown` (UnknownRoomError, this
 * seam's own vocabulary). Roster derivation mirrors the app's single
 * authority: membership derives from durable Agent `refs` (teams.jsonl holds
 * NO member lists), filtered to status 'live' | 'spawning' — retired/failed
 * agents cannot receive, and including them would manufacture terminal
 * delivery failures on every room send.
 *
 * D-N3-1 (fleet room for #team): authority "fleet" with the constant
 * externalId FLEET_EXTERNAL_ID ("team") resolves to EVERY active durable
 * agent. Owner host policy: the human principal (when configured) is in
 * EVERY roster this adapter serves — team, mission, and fleet — so Chris's
 * sends authorize (R4's same-resolution member check) and his session
 * passes isMember reads. The revision hash covers the human inclusion by
 * construction (it hashes the served roster).
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
import { isActiveAgent, personIdForAgentId } from '../authority/index.js';

/** The RoomRef authorities this adapter serves (§3.1 + D-N3-1's fleet). */
const KNOWN_AUTHORITIES: ReadonlySet<string> = new Set(['mission', 'team', 'fleet']);

/** D-N3-1: the fleet room's one externalId — the #team lane. */
export const FLEET_EXTERNAL_ID = 'team';

/** Roster derivation: the shared lifecycle predicate (finding 7), deduped by
 * personId (N1 audit finding 9 — ObjectModel.missionAgents does not fold by
 * id; a duplicated agent line must never double-receive a room send). */
function rosterOf(blocks: AgentBlock[]): PersonId[] {
  return [...new Set(blocks.filter(isActiveAgent).map((block) => personIdForAgentId(block.id)))];
}

/** D-N3-1 owner host policy: the human principal is in EVERY served roster. */
function withHuman(members: PersonId[], humanPersonId: PersonId | undefined): PersonId[] {
  if (humanPersonId === undefined || members.includes(humanPersonId)) return members;
  return [...members, humanPersonId];
}

/** §3.2.3: the authority has no native revision token — hash the sorted roster. */
function revisionFor(members: PersonId[]): string {
  const sorted = [...members].sort().join('\n');
  return createHash('sha256').update(sorted).digest('hex');
}

/** Fresh roster resolution (R8 — no cache); null when the room is unknown. */
function resolveFresh(objectModel: ObjectModel, room: RoomRef, externals?: () => string[]): PersonId[] | null {
  if (room.authority === 'fleet') {
    // D-N3-1: one fleet room only — any other externalId is an unknown room.
    if (room.externalId !== FLEET_EXTERNAL_ID) return null;
    // D-N8-2: ACTIVE external principals ride the fleet roster ONLY (team
    // and mission rosters stay ref-derived). Room sends reach them as
    // recipients (R4/§11.7 frozen snapshots) and they may send into #team.
    return [...rosterOf(objectModel.listAgents()), ...(externals?.() ?? []).map((personId) => personId as PersonId)];
  }
  if (room.authority === 'mission') {
    if (objectModel.missionRecord(room.externalId) === null) return null;
    return rosterOf(objectModel.missionAgents(room.externalId));
  }
  // room.authority === 'team' (checked by the callers)
  if (objectModel.teamRecord(room.externalId) === null) return null;
  return rosterOf(
    objectModel
      .listAgents()
      .filter((block) =>
        block.refs?.some((reference) => reference.kind === 'team' && reference.value === room.externalId),
      ),
  );
}

/** §3.3: a read throw is a typed dependency failure, never a leaked exception. */
function resolveSafely(objectModel: ObjectModel, room: RoomRef, externals?: () => string[]): PersonId[] | null | MessagingError {
  try {
    return resolveFresh(objectModel, room, externals);
  } catch (error) {
    return membershipUnavailable(
      `membership read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function makeResolveMembers(
  objectModel: ObjectModel,
  clock: ClockIds,
  humanPersonId: PersonId | undefined,
  externals?: () => string[],
): MembershipSource['resolveMembers'] {
  return async (room): Promise<ResolveMembersOutcome> => {
    if (!KNOWN_AUTHORITIES.has(room.authority)) return { kind: 'unknown', error: unknownRoom(room) };
    const resolved = resolveSafely(objectModel, room, externals);
    if (resolved instanceof MessagingError) return { kind: 'unavailable', error: resolved };
    if (resolved === null) return { kind: 'unknown', error: unknownRoom(room) };
    const members = withHuman(resolved, humanPersonId);
    return {
      kind: 'resolved',
      members,
      evidence: { authority: room.authority, revision: revisionFor(members), resolvedAt: clock.now() },
    };
  };
}

function makeIsMember(
  objectModel: ObjectModel,
  humanPersonId: PersonId | undefined,
  externals?: () => string[],
): MembershipSource['isMember'] {
  return async (room, personId): Promise<IsMemberOutcome> => {
    if (!KNOWN_AUTHORITIES.has(room.authority)) return { kind: 'unknown', error: unknownRoom(room) };
    const resolved = resolveSafely(objectModel, room, externals);
    if (resolved instanceof MessagingError) return { kind: 'unavailable', error: resolved };
    if (resolved === null) return { kind: 'unknown', error: unknownRoom(room) };
    return { kind: 'known', member: withHuman(resolved, humanPersonId).includes(personId) };
  };
}

export function createNovakaiMembership(
  objectModel: ObjectModel,
  clock: ClockIds,
  /** D-N3-1: the human principal, included in every served roster when set. */
  humanPersonId?: PersonId,
  /** D-N8-2: active external personIds (fleet roster only). */
  externals?: () => string[],
): MembershipSource {
  return {
    resolveMembers: makeResolveMembers(objectModel, clock, humanPersonId, externals),
    isMember: makeIsMember(objectModel, humanPersonId, externals),
  };
}
