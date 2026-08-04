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
  ActivityGeneration, AgentRunId, B3Result, IsoUtc, ProviderSessionId,
  ProviderTurnBoundaryProfileId, ProviderTurnId, TerminalSessionId,
  TranscriptBindingId, TranscriptLineId,
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
  readonly turnBoundary: ProviderCapability;
  readonly turnBoundaryProfile: ProviderTurnBoundaryProfile | null;
}

export interface ProviderTurnBoundaryProfile {
  readonly id: ProviderTurnBoundaryProfileId;
  readonly provider: ProviderKind;
  readonly executableVersion: string;
  readonly sourceFormatSchemaDigest: string;
  readonly inputFrame: {
    readonly discriminatorPath: string;
    readonly discriminatorValue: string;
    readonly logicalUtf8TextPath: string;
    readonly providerNativeSessionIdPath: string;
    readonly providerNativeTurnIdPath?: string;
  };
  readonly completionFrame: {
    readonly discriminatorPath: string;
    readonly terminalDiscriminatorValues: readonly [string, ...string[]];
    readonly providerNativeSessionIdPath: string;
    readonly providerNativeTurnIdPath?: string;
    readonly terminalSemanticsEvidenceDigest: string;
  };
  readonly correlation:
    | { readonly mode: 'shared-provider-native-turn-id'; readonly inputAndCompletionPathsRequired: true }
    | {
        readonly mode: 'explicit-response-envelope';
        readonly correlationIdPath: string;
        readonly phasePath: string;
        readonly inputStartPhaseValue: string;
        readonly completionTerminalPhaseValue: string;
      };
  readonly ordering: {
    readonly mode: 'strict-monotonic-source-position';
    readonly intermediateToolFramesMustShareCorrelation: true;
    readonly sourceGapInvalidatesProof: true;
  };
  readonly evidenceDigestRecipe: 'sha256(canonical-json(profileId,providerNativeSessionId,providerNativeTurnIdOrCorrelationId,inputPosition,completionPosition,inputSourceDigest,completionSourceDigest,orderedIntermediateSourceDigests))';
}

export interface ProviderTurnBoundaryInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerNativeSessionId: string;
  readonly transcriptBindingId: TranscriptBindingId;
  readonly providerTurnId: ProviderTurnId;
  readonly inputDigest: string;
  readonly startTranscriptWatermark: string | null;
  readonly currentTranscriptWatermark: string | null;
}

export type ProviderTurnBoundaryObservation =
  | {
      readonly kind: 'proven';
      readonly providerCorrelationId: string;
      readonly providerNativeTurnId?: string;
      readonly submittedInputSourcePosition: string;
      readonly completionSourcePosition: string;
      readonly completionSourceCommittedAt: IsoUtc;
      readonly submittedInputEvidenceDigest: string;
      readonly sourceLineIds: readonly [TranscriptLineId, ...TranscriptLineId[]];
      readonly resultingWatermark: string;
      readonly turnBoundaryProfileId: ProviderTurnBoundaryProfileId;
      readonly framingEvidenceDigest: string;
      readonly limitations: readonly string[];
    }
  | {
      readonly kind: 'uncertain';
      readonly reason: 'input-frame-ambiguous' | 'end-frame-ambiguous' | 'source-gap' | 'provider-version-unsupported';
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'no-authoritative-turn-framing' | 'source-unavailable' | 'adapter-unsupported';
      readonly evidenceRefs: readonly string[];
    };

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

  observeProviderTurnBoundary(
    input: ProviderTurnBoundaryInput,
  ): Promise<B3Result<ProviderTurnBoundaryObservation>>;

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
   * `adapters/providers/turn-delivery.ts` for what was measured, on which
   * binaries, and why the turn is no longer flattened on the way through.
   */
  deliverTurn(text: string): readonly TurnDeliveryStep[];

  /**
   * Whether this output carries the canonical confirmation line. The ADAPTER
   * decides because only it knows what its CLI wraps output in.
   */
  findConfirmationLine(
    observation: ProviderReplyObservation, marker: string,
  ): string | null;

  /**
   * Whether this session has painted enough to be READING its input yet.
   *
   * `live` means the process was spawned. It does not mean the process is
   * listening, and the gap between the two is where turn 1 died: a CLI opens by
   * firing terminal-capability queries and parsing the answers, and bytes
   * written into that window are consumed by the parser rather than by the
   * composer. The turn never becomes a provider turn and no transcript is
   * written at all — measured 7 times out of 7 against real claude
   * (NVK-KIMI-078).
   *
   * Provider-declared, for the same reason `deliverTurn` and
   * `findConfirmationLine` are: what a composer looks like is a fact about one
   * CLI's paint. It is not a duration either — two arms writing at an identical
   * 1.2 s went opposite ways — so an adapter must answer from the SCREEN.
   *
   * The argument is the session's raw paint, escape sequences included. See
   * `adapters/providers/input-readiness.ts` for what each CLI draws, when, and
   * which captures say so.
   */
  inputReadyOn(screen: string): boolean;
}

export type ProviderAdapterRegistry = Readonly<
  Record<ProviderKind, InteractiveProviderAdapter>
>;
