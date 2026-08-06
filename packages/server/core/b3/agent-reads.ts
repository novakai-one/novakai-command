// Boundary validators for the reads the wire adds over §12's capability APIs.
//
// They live here rather than in a capability package because the SHAPE is the
// wire's: `getTreeFence` and `listGrants` take a request the capability method
// spells out as arguments. Everything they validate is still read from
// `unknown` before anything acts on it (§4.2 MUST).
import {
  readBoundary,
  type AgentId, type AgentRunId, type B3Result, type EventCursor,
} from '@novakai/foundation/contract';

export function readAgentIdInput(
  candidate: unknown,
): B3Result<{ readonly agentId: AgentId }> {
  return readBoundary(candidate, (field) => ({
    agentId: field.id<AgentId>('agentId', 'agent', 'uuidv4'),
  }));
}

/**
 * A5-04's one argument. `displayName` is read as text and nothing more: the
 * match itself — exact, case-sensitive, whole-string — is the owner's, and a
 * boundary that trimmed or folded it here would be a second matching rule.
 */
export function readResolveRoleByNameInput(
  candidate: unknown,
): B3Result<{ readonly displayName: string }> {
  return readBoundary(candidate, (field) => ({
    displayName: field.text('displayName'),
  }));
}

export function readReadRunEventsInput(
  candidate: unknown,
): B3Result<{ readonly after?: EventCursor; readonly limit?: number }> {
  return readBoundary(candidate, (field) => {
    const after = field.given('after') === undefined
      ? undefined : field.text('after') as EventCursor;
    const limit = field.optionalCount('limit', 1, 1_000);
    return {
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    };
  });
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
