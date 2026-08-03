// What a provider must answer.
//
// Split out of `ports.ts` because this is the seam with the most implementations
// and the least in common with the rest: `claude`, `codex` and `kimi` each vary
// here, and nothing else in the Runtime's port set varies by provider at all.
//
// Re-exported from `ports.ts`, so no consumer changes.
import type {
  ActivityGeneration, AgentRunId, B3Result, ProviderSessionId, ProviderTurnId,
  ProviderTurnBoundaryProfileId, TerminalSessionId,
} from '@novakai/foundation/contract';
import type { ContinuationMode } from './runs.js';
import type { TurnDeliveryStep } from './types.js';
import type { LaunchPlanFacts } from './launch-facts.js';

export interface ProviderLaunchFacts {
  /** Opaque: the Runtime registered it and Terminal resolves it. */
  readonly launchAuthorityRef: string;
  readonly launchFingerprint: string;
  readonly providerNativeSessionId: string;
  readonly resumeHandleUsed: boolean;
}

/**
 * Providers, seen as three questions: what should this Run launch, what did the
 * provider turn out to be, and how do I say something to it.
 */
export interface ProviderPort {
  turnBoundaryCapability(provider: 'claude' | 'codex' | 'kimi'): Promise<B3Result<{
    readonly testedProviderVersion: string;
    readonly profileId: ProviderTurnBoundaryProfileId;
  }>>;
  prepareLaunch(
    input: {
      readonly launchPlan: LaunchPlanFacts;
      readonly agentRunId: AgentRunId;
      readonly reservedProviderSessionId: ProviderSessionId;
      readonly runtimeEnvironment: Readonly<Record<string, string>>;
      readonly columns: number;
      readonly rows: number;
    },
  ): Promise<B3Result<{ readonly launchAuthorityRef: string; readonly launchFingerprint: string }>>;

  prepareContinuation(
    input: {
      readonly launchPlan: LaunchPlanFacts;
      readonly mode: ContinuationMode;
      readonly agentRunId: AgentRunId;
      readonly reservedProviderSessionId: ProviderSessionId;
      readonly oldNativeSessionId: string;
      readonly handoverArtifactId?: string;
      readonly runtimeEnvironment: Readonly<Record<string, string>>;
      readonly columns: number;
      readonly rows: number;
    },
  ): Promise<B3Result<ProviderLaunchFacts>>;

  discoverSession(
    input: {
      readonly provider: 'claude' | 'codex' | 'kimi';
      readonly agentRunId: AgentRunId;
      readonly expectedProviderSessionId: ProviderSessionId;
      readonly terminalSessionId: TerminalSessionId;
      readonly launchFingerprint: string;
    },
  ): Promise<B3Result<{
    readonly providerSessionId: ProviderSessionId;
    readonly providerNativeSessionId: string;
    readonly live: 'live' | 'final' | 'unknown';
  }>>;

  requestInterrupt(
    input: {
      readonly provider: 'claude' | 'codex' | 'kimi';
      readonly providerSessionId: ProviderSessionId;
      readonly providerTurnId: ProviderTurnId;
      readonly activityGeneration: ActivityGeneration;
    },
  ): Promise<B3Result<{ readonly kind: 'interrupt-requested' | 'already-completed' | 'unsupported' }>>;

  /**
   * How this provider's composer must be TYPED at to accept one turn. Never one
   * write: an Enter inside a big burst is absorbed as pasted text.
   */
  deliverTurn(provider: 'claude' | 'codex' | 'kimi', text: string): readonly TurnDeliveryStep[];

  findConfirmationLine(
    provider: 'claude' | 'codex' | 'kimi', text: string, marker: string,
  ): string | null;
}
