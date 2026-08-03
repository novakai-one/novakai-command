import type {
  AgentId,
  AgentRunId,
  AuthenticatedPrincipal,
  B3Page,
  B3Result,
  ProviderSessionId,
} from '@novakai/foundation/contract';
import type { ProviderUsageEvidence } from '../../contract/index.js';

/** Runtime-owned facts sufficient to project usage without assembling a Run view. */
export interface UsageRunFacts {
  readonly agentRunId: AgentRunId;
  readonly agentId: AgentId;
  readonly providerSessionId: ProviderSessionId;
  readonly final: boolean;
}

/** Composition adapter over Agent Runtime's authoritative Run records. */
export interface UsageRunReader {
  getUsageRun(
    principal: AuthenticatedPrincipal,
    agentRunId: AgentRunId,
  ): Promise<B3Result<UsageRunFacts>>;
  listUsageRuns(
    principal: AuthenticatedPrincipal,
    agentId: AgentId,
  ): Promise<B3Result<readonly UsageRunFacts[]>>;
}

/** Composition adapter over Agents' append-only evidence query. */
export interface UsageEvidenceReader {
  listProviderUsageEvidence(
    principal: AuthenticatedPrincipal,
    providerSessionId: ProviderSessionId,
  ): Promise<B3Result<B3Page<ProviderUsageEvidence>>>;
}
