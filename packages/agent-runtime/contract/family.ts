// The family facts the Runtime reads but never writes.
//
// Parentage is Agents' truth (§3.3, red gate 9). The Runtime publishes these
// edges in the tree it serves (§12.7 `AgentRunTreeView.edges`) and takes them
// through the ports, exactly as it takes control facts — separate from
// `ports.ts` so neither file becomes the place every shape ends up.
import type { AgentId, AgentRunId, HumanPrincipalId } from '@novakai/foundation/contract';

/** One immutable spawn edge, as Agents recorded it. */
export interface AgentRelationshipFacts {
  readonly id: string;
  readonly kind: 'agentRelationship';
  readonly rootHumanPrincipalId: HumanPrincipalId;
  readonly parentAgentId: AgentId;
  readonly childAgentId: AgentId;
  readonly createdFromRunId: AgentRunId;
}
