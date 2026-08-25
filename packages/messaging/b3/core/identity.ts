/**
 * How an Agent appears inside Messaging — B3V4-P2 §8, red gate 3.
 *
 * Messaging addresses `PersonId`. B3 addresses `AgentId`. These are two
 * different identities for two different things and must never be
 * interchangeable, so the mapping is an explicit, reversible, total function
 * rather than an assignment.
 *
 * `agent_<uuid>` → `person_agent-<uuid>`: the `person_` prefix keeps every
 * existing Messaging validator honest, the `agent-` infix says out loud that
 * this Person IS an Agent, and the transform is reversible so a communication
 * projection can name the Agent again without a lookup table.
 *
 * The one thing this deliberately does NOT do is let an AgentId be passed
 * where a PersonId is expected. `agent_x` fails Messaging's `^person_` pattern
 * on the way in, which is the failure mode red gate 3 wants.
 */

import type { PersonId, ThreadId } from "../../contract/schemas.js";
import type { AgentId } from "../contract/records.js";

const AGENT_PERSON_PREFIX = "person_agent-";

/** The Messaging identity for an Agent. Total and reversible. */
export function agentPersonId(agentId: AgentId): PersonId {
  return `${AGENT_PERSON_PREFIX}${agentId.slice("agent_".length)}` as PersonId;
}

/** The Agent behind a Messaging identity, or null when the Person is a human. */
export function agentIdOf(personId: PersonId): AgentId | null {
  if (!personId.startsWith(AGENT_PERSON_PREFIX)) return null;
  return `agent_${personId.slice(AGENT_PERSON_PREFIX.length)}` as AgentId;
}

export const isAgentPerson = (personId: PersonId): boolean =>
  personId.startsWith(AGENT_PERSON_PREFIX);

/**
 * The room key for a deliberately-opened group conversation (§11.4, DEC-B3V4-17).
 *
 * Sorted, so {A,B,C} and {C,A,B} are one conversation rather than two — a
 * group is a set of participants, and the order someone typed them in is not
 * part of its identity. Fields join with U+001F, matching §4.1's tuple rule,
 * so no participant id can be split across the boundary of another.
 */
export const GROUP_THREAD_AUTHORITY = "novakai-agent-group";

export function groupExternalId(participants: readonly PersonId[]): string {
  return [...new Set(participants)].sort().join("\u001f");
}

/**
 * The threads a communication query should look at for a set of Agents. Kept
 * here beside the mapping so a caller never re-derives the convention.
 */
export interface ThreadScope {
  readonly threadIds: readonly ThreadId[];
}
