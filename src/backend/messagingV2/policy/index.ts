/**
 * messagingV2 team contact bootstrap (D-N2-5 — composition policy, the core
 * is untouched). DEC-14's deny-by-default stays the gate; this module owns
 * membership-driven contact bootstrapping as HOST POLICY, the same
 * philosophy as D4's role→grant mapping living in adapter config: the core
 * only ever sees the boolean outcome of a setContactPolicy command.
 *
 * Co-membership: durable agents (live/spawning — the authority's ONE
 * lifecycle predicate) sharing any `team` or `mission` ref value (union),
 * PLUS the human principal. On every sync, each held agent session's
 * allowlist becomes its co-members (+ the human); the human's allowlist
 * becomes every durable team agent (agent→chris DMs send cleanly; delivery
 * still pends until N4 — expected).
 *
 * ADDITIVE-ONLY within N2 (the noted limitation): a sync UNIONS the computed
 * set over the principal's current allowlist — it never shrinks, so agent
 * exits, retirement, and manual allowlist entries are all preserved.
 * Retire/revocation (shrinking) is a later-slice concern. Only principals
 * the glue holds sessions for are ever touched.
 */

import type { PersonId } from '../../../../packages/messaging/public/contract/index.js';
import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import type { AgentBlock, ObjectModel } from '../../objectModel/index.js';
import { isActiveAgent, personIdForAgentId } from '../authority/index.js';

export interface PolicySyncFailure {
  personId: string;
  detail: string;
}

export interface ContactBootstrap {
  /**
   * Recompute and union-set the allowlist for every held session. NEVER
   * throws for a per-session write failure (audit #6): failures are
   * collected and returned so one poisoned session cannot starve the others
   * — the sync is host policy, never a lane gate.
   */
  sync(sessions: ReadonlyMap<string, MessagingSession>, human: MessagingSession | null): Promise<PolicySyncFailure[]>;
}

/** The refs that define team co-membership (union semantics). */
function teamRefValues(block: AgentBlock): Set<string> {
  const values = block.refs
    .filter((entry) => entry.kind === 'team' || entry.kind === 'mission')
    .map((entry) => entry.value);
  return new Set(values);
}

function isCoMember(self: AgentBlock, other: AgentBlock): boolean {
  if (other.id === self.id) return false;
  const shared = teamRefValues(self);
  return [...teamRefValues(other)].some((value) => shared.has(value));
}

/** The current allowlist; an unreadable policy yields the empty base. */
async function currentAllowlist(session: MessagingSession): Promise<PersonId[]> {
  const policy = await session.getPolicy({});
  return policy.kind === 'ok' ? policy.value.contact.allowlist : [];
}

/** Union-set one principal's allowlist (deny-by-default preserved). Returns
 * the failure detail, or null on success — a throw OR an error outcome is a
 * failure (honesty both ways), never a propagated exception (audit #6). */
async function growAllowlist(session: MessagingSession, added: PersonId[]): Promise<string | null> {
  try {
    const allowlist = [...new Set([...(await currentAllowlist(session)), ...added])];
    const outcome = await session.setContactPolicy({ allowlist, defaultRule: 'deny' });
    if (outcome.kind === 'ok') return null;
    return `${outcome.error.name}: ${outcome.error.message}`;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** The allowlist delta for one session (D-N8-2: an external's list is the
 * WHOLE fleet — fleet co-membership by construction, not refs). */
function addedForSession(
  personId: string,
  blocks: AgentBlock[],
  externalPersonIds: PersonId[],
  humanPersonId: PersonId | undefined,
): PersonId[] | null {
  const isExternal = externalPersonIds.includes(personId as PersonId);
  const self = isExternal ? undefined : blocks.find((block) => personIdForAgentId(block.id) === personId);
  if (!isExternal && self === undefined) return null; // plain spawn or retired mid-run — not ours to touch
  const added = isExternal
    ? [...blocks.map((block) => personIdForAgentId(block.id)), ...externalPersonIds.filter((other) => other !== personId)]
    : [
        ...blocks.filter((block) => isCoMember(self as AgentBlock, block)).map((block) => personIdForAgentId(block.id)),
        ...externalPersonIds, // fleet co-members (D-N8-2 — deny-by-default stays the gate)
      ];
  if (humanPersonId !== undefined) added.push(humanPersonId);
  return added;
}

async function syncAgents(
  blocks: AgentBlock[],
  sessions: ReadonlyMap<string, MessagingSession>,
  humanPersonId: PersonId | undefined,
  externalPersonIds: PersonId[],
  failures: PolicySyncFailure[],
): Promise<void> {
  for (const [personId, session] of sessions) {
    const added = addedForSession(personId, blocks, externalPersonIds, humanPersonId);
    if (added === null) continue;
    const detail = await growAllowlist(session, added);
    if (detail !== null) failures.push({ personId: personId as PersonId, detail });
  }
}

/** The human's own sync: every agent + every external (the owner sees all). */
async function syncHuman(
  human: MessagingSession,
  blocks: AgentBlock[],
  externalPersonIds: PersonId[],
  failures: PolicySyncFailure[],
): Promise<void> {
  const added = [
    ...blocks.map((block) => personIdForAgentId(block.id)),
    ...externalPersonIds, // the owner sees every external as a co-member
  ];
  const detail = await growAllowlist(human, added);
  if (detail !== null) failures.push({ personId: human.principal.personId, detail });
}

export function createContactBootstrap(
  objectModel: ObjectModel,
  /** D-N8-2: active external personIds — fleet co-members of EVERYONE. */
  externals?: () => string[],
): ContactBootstrap {
  return {
    async sync(sessions, human) {
      const failures: PolicySyncFailure[] = [];
      const blocks = objectModel.listAgents().filter(isActiveAgent);
      const externalPersonIds = (externals?.() ?? []).map((personId) => personId as PersonId);
      await syncAgents(blocks, sessions, human?.principal.personId, externalPersonIds, failures);
      if (human !== null) await syncHuman(human, blocks, externalPersonIds, failures);
      return failures;
    },
  };
}
