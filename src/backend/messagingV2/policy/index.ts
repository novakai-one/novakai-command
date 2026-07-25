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

export interface ContactBootstrap {
  /** Recompute and union-set the allowlist for every held session. */
  sync(sessions: ReadonlyMap<string, MessagingSession>, human: MessagingSession | null): Promise<void>;
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

/** Union-set one principal's allowlist (deny-by-default preserved). */
async function growAllowlist(session: MessagingSession, added: PersonId[]): Promise<void> {
  const allowlist = [...new Set([...(await currentAllowlist(session)), ...added])];
  await session.setContactPolicy({ allowlist, defaultRule: 'deny' });
}

async function syncAgents(
  blocks: AgentBlock[],
  sessions: ReadonlyMap<string, MessagingSession>,
  humanPersonId: PersonId | undefined,
): Promise<void> {
  for (const [agentId, session] of sessions) {
    const self = blocks.find((block) => block.id === agentId);
    if (self === undefined) continue; // plain spawn or retired mid-run — not ours to touch
    const added = blocks
      .filter((block) => isCoMember(self, block))
      .map((block) => personIdForAgentId(block.id));
    if (humanPersonId !== undefined) added.push(humanPersonId);
    await growAllowlist(session, added);
  }
}

export function createContactBootstrap(objectModel: ObjectModel): ContactBootstrap {
  return {
    async sync(sessions, human) {
      const blocks = objectModel.listAgents().filter(isActiveAgent);
      await syncAgents(blocks, sessions, human?.principal.personId);
      if (human !== null) {
        await growAllowlist(human, blocks.map((block) => personIdForAgentId(block.id)));
      }
    },
  };
}
