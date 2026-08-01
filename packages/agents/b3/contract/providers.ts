// The interactive provider adapter contract (B3V4-P2 §14).
//
// One rule shapes all of it: an adapter reports what its CLI can actually do
// and never translates an unsupported command into a different effect. If
// Codex cannot change model mid-session, the honest answer is
// `replacement-required` — not a silent restart wearing the word "applied".
//
// Everything private stays private: executable paths, argv, environment, PIDs,
// resume handles and native session ids never appear in a public contract.
import type {
  ActivityGeneration, AgentRunId, B3Result, ProviderSessionId, ProviderTurnId,
  TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  AgentControl, ContinuationMode, ProviderKind, ResolvedLaunchPlan, SupportLevel,
} from './records.js';

export interface ProviderCapability {
  readonly support: SupportLevel;
  /** Why the adapter believes this — a version probe, a doc, a live test. */
  readonly evidence: string;
  readonly limitations: readonly string[];
}

export interface ProviderCapabilityReport {
  readonly provider: ProviderKind;
  readonly testedProviderVersion: string;
  readonly resume: ProviderCapability;
  readonly fresh: ProviderCapability;
  readonly compact: ProviderCapability;
  readonly modelChange: ProviderCapability;
  readonly effortChange: ProviderCapability;
  readonly interrupt: ProviderCapability;
  readonly safeMessageBoundary: ProviderCapability;
  readonly transcriptDiscovery: ProviderCapability;
  readonly usage: ProviderCapability;
  readonly screenContext: ProviderCapability;
  readonly nativeSubagentObservation: ProviderCapability;
}

export interface ProviderLaunchInput {
  readonly workingDirectory: string;
  readonly columns: number;
  readonly rows: number;
  /**
   * The id Runtime minted BEFORE the Run record existed (§5.4). A CLI that
   * accepts a pre-assigned conversation id gets it here, which makes the
   * reservation an identity rather than something to be inferred later.
   */
  readonly reservedProviderSessionId: ProviderSessionId;
  /**
   * Environment the Runtime needs the child to inherit — how a spawned Agent
   * authenticates as ITSELF when it runs `nvk agent spawn` (DEC-B3V4-05).
   * The adapter merges it; it never invents or inspects it.
   */
  readonly runtimeEnvironment: Readonly<Record<string, string>>;
}

/** What actually gets executed. Private to adapters and the PTY host. */
export interface PrivateProviderLaunch {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  /** Identifies WHAT was launched, so a recovering Runtime can recognise it. */
  readonly launchFingerprint: string;
  readonly privateResumeHandle?: string;
}

export interface ProviderSessionDiscoveryInput {
  readonly agentRunId: AgentRunId;
  readonly expectedProviderSessionId: ProviderSessionId;
  readonly terminalSessionId: TerminalSessionId;
  readonly launchFingerprint: string;
}

export interface ProviderSessionEvidence {
  /** MUST exactly echo the expected id. A substitute is refused, not rebound. */
  readonly providerSessionId: ProviderSessionId;
  readonly providerNativeSessionId: string;
  readonly live: 'live' | 'final' | 'unknown';
  readonly evidence: readonly string[];
}

export interface ProviderContinuationInput {
  readonly mode: ContinuationMode;
  readonly oldSession: ProviderSessionEvidence;
  readonly launchPlan: ResolvedLaunchPlan;
  readonly handoverArtifactId?: string;
  readonly workingDirectory: string;
  readonly columns: number;
  readonly rows: number;
  readonly runtimeEnvironment: Readonly<Record<string, string>>;
}

export interface ProviderInterruptInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
}

export type ProviderInterruptOutcome =
  | { readonly kind: 'interrupt-requested' }
  | { readonly kind: 'already-completed' }
  | { readonly kind: 'unsupported'; readonly reason: string };

export interface ProviderControlInput {
  readonly providerSessionId: ProviderSessionId;
  readonly control: AgentControl;
}

export type ProviderControlOutcome =
  | { readonly kind: 'applied-native' }
  | { readonly kind: 'replacement-required'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };

/**
 * How the Runtime learns what a provider said. B3b reads the managed PTY's own
 * output, which is the only evidence that exists before Transcript binding
 * arrives in B3c; the seam is here so B3c can supply transcript-backed
 * observation without the gate changing.
 */
export interface ProviderReplyObservation {
  /** Text the session has produced since the launch, newest content included. */
  readonly text: string;
}

/**
 * One write in a turn's delivery, and the beat that must pass before the next.
 *
 * The pause is part of the contract rather than a caller's guess: two writes
 * issued back to back can still reach the provider as a single chunk, and a
 * chunk is exactly what a composer takes for a paste.
 */
export interface TurnDeliveryStep {
  readonly utf8Text: string;
  readonly pauseMsAfter: number;
}

export interface InteractiveProviderAdapter {
  readonly provider: ProviderKind;

  discoverCapabilities(): Promise<ProviderCapabilityReport>;

  buildLaunch(
    plan: ResolvedLaunchPlan, input: ProviderLaunchInput,
  ): Promise<B3Result<PrivateProviderLaunch>>;

  discoverSession(
    input: ProviderSessionDiscoveryInput,
  ): Promise<B3Result<ProviderSessionEvidence>>;

  buildContinuation(
    input: ProviderContinuationInput,
  ): Promise<B3Result<PrivateProviderLaunch>>;

  requestInterrupt(
    input: ProviderInterruptInput,
  ): Promise<B3Result<ProviderInterruptOutcome>>;

  applyControl(
    input: ProviderControlInput,
  ): Promise<B3Result<ProviderControlOutcome>>;

  /**
   * How a supervised turn must be TYPED at this provider, in order. Providers
   * differ in what ends a prompt, and guessing "\r" for all three is exactly
   * the invented parity §14 forbids.
   *
   * Not one string, because delivering a turn is not one write: a TUI takes a
   * big fast burst for a paste and absorbs an Enter inside it as text. See
   * `deliverAsOneLine` for what was measured.
   */
  deliverTurn(text: string): readonly TurnDeliveryStep[];

  /**
   * Whether this output carries the canonical confirmation line. The ADAPTER
   * decides because only it knows what its CLI wraps output in.
   */
  findConfirmationLine(
    observation: ProviderReplyObservation, marker: string,
  ): string | null;
}

export type ProviderAdapterRegistry = Readonly<
  Record<ProviderKind, InteractiveProviderAdapter>
>;
