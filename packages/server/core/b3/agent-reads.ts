// Boundary validators for the reads the wire adds over §12's capability APIs.
//
// They live here rather than in a capability package because the SHAPE is the
// wire's: `getTreeFence` and `listGrants` take a request the capability method
// spells out as arguments. Everything they validate is still read from
// `unknown` before anything acts on it (§4.2 MUST).
import {
  readBoundary,
  type AgentId, type AgentRunId, type B3Result,
} from '@novakai/foundation/contract';

export function readAgentIdInput(
  candidate: unknown,
): B3Result<{ readonly agentId: AgentId }> {
  return readBoundary(candidate, (field) => ({
    agentId: field.id<AgentId>('agentId', 'agent', 'uuidv4'),
  }));
}

export function readListGrantsFilter(
  candidate: unknown,
): B3Result<{ readonly holderAgentRunId?: AgentRunId }> {
  return readBoundary(candidate, (field) => {
    const holderAgentRunId = field.given('holderAgentRunId') === undefined
      ? undefined
      : field.id<AgentRunId>('holderAgentRunId', 'agentRun');
    return holderAgentRunId === undefined ? {} : { holderAgentRunId };
  });
}
