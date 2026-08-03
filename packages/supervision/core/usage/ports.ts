import type {
  AgentId,
  AgentRunId,
  AuthenticatedPrincipal,
  B3Page,
  B3Result,
  IsoUtc,
  ProviderSessionId,
} from '@novakai/foundation/contract';
import type { ProviderUsageEvidence } from '../../contract/index.js';

export interface ProviderTurnSubmissionUsageFacts {
  readonly providerTurnId: import('@novakai/foundation/contract').ProviderTurnId;
  readonly state:
    | 'queued' | 'prepared' | 'submitted-confirmed' | 'submitted-unconfirmed'
    | 'completed' | 'rejected' | 'recovery-required' | 'completion-unproven-final';
}

/** Runtime-owned facts sufficient to project usage without assembling a Run view. */
export interface UsageRunFacts {
  readonly agentRunId: AgentRunId;
  readonly agentId: AgentId;
  readonly providerSessionId: ProviderSessionId;
  readonly final: boolean;
  /** Omitted means a legacy/no-submission Run; a present array is enumerable truth. */
  readonly providerTurnSubmissions?: readonly ProviderTurnSubmissionUsageFacts[];
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

/** Read-only provider-transcript totals supplied by the composition root. */
export interface TranscriptUsageSample {
  readonly quality: 'estimated' | 'partial' | 'unavailable';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly observedAt: IsoUtc;
  readonly source: string;
  readonly limitations: readonly string[];
}

/** Adapter over Transcript evidence; it owns no usage state and performs no writes. */
export interface TranscriptUsageReader {
  readTranscriptUsage(
    principal: AuthenticatedPrincipal,
    runFacts: UsageRunFacts,
  ): Promise<B3Result<TranscriptUsageSample>>;
}
