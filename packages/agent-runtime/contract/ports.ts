// The seams Agent Runtime genuinely varies at.
//
// Agent Runtime never imports Agents or Terminal. It states the NARROW thing it
// needs from each and the composition root supplies it. That is not plumbing
// convenience: a Runtime that could reach the whole Agents contract could create
// a role profile, and the one-writer law says it may not (§3.3). The port is
// the enforcement.
//
// Each port is also the test seam. Every failure-injection case in this slice is
// a port that answers differently — a crash, a stale epoch, a substituted
// session id — rather than a mocked internal.
import type {
  AgentId, AgentRoleProfileId, AgentRunId, AuthenticatedPrincipal, AuthorityScope,
  B3Result, CommandContext, ControlReplacementPlanId, DelegationGrantId,
  HumanPrincipalId, ProviderSessionId, ProviderTurnId, ActivityGeneration,
  RecordVersion, ResolvedLaunchPlanId, RuntimeEpochId, TerminalSessionId,
} from '@novakai/foundation/contract';
import type { ContinuationMode, LaunchConfigurationMode, LaunchSurface } from './runs.js';
import type { TurnDeliveryStep } from './types.js';
import type {
  AgentControlFacts, AgentControlOutcomeFacts, ControlCapabilityFacts,
} from './controls.js';
import type { AgentRelationshipFacts } from './family.js';

export type {
  AgentControlFacts, AgentControlOutcomeFacts, AgentRelationshipFacts,
  ControlCapabilityFacts,
};

// ── What Agents must answer ─────────────────────────────────────────────────

/** The launch facts a Run is pinned to. Runtime reads these; it never edits them. */
export interface LaunchPlanFacts {
  readonly id: ResolvedLaunchPlanId;
  readonly agentId: AgentId;
  readonly provider: 'claude' | 'codex' | 'kimi';
  readonly modelId: string;
  readonly effort: string;
  readonly workingDirectory: string;
  readonly skills: readonly { readonly id: string; readonly version: number; readonly digest: string }[];
  readonly skillsConfirmationGate:
    | { readonly mode: 'disabled' }
    | {
        readonly mode: 'required-two-turn';
        readonly confirmationMarker: string;
        readonly onFailure: 'terminate-run-and-record-drift';
      };
  readonly lifecyclePolicy: {
    readonly onSupervisorFinal:
      | 'assign-human' | 'assign-nearest-live-ancestor' | 'remain-orphaned';
    readonly allowedContinuationModes: readonly ContinuationMode[];
  };
  readonly spawnPolicy: {
    /**
     * The child roles this Run may spawn. The Runtime asks for exactly these
     * when it issues the Run's own grant — Agents then intersects them down to
     * what the CALLER actually held, so the grant can only ever shrink.
     */
    readonly allowedChildRoleIds: readonly AgentRoleProfileId[];
    readonly maxLiveChildren?: number;
  };
}

export interface AgentFacts {
  readonly id: AgentId;
  readonly displayName: string;
  readonly roleProfileId: AgentRoleProfileId;
  readonly rootHumanPrincipalId: HumanPrincipalId;
  readonly status: 'active' | 'archived';
}

export interface SpawnAuthorityFacts {
  readonly rootHumanPrincipalId: HumanPrincipalId;
  readonly parentAgentId?: AgentId;
  readonly grantId?: DelegationGrantId;
  readonly launchSurface: string;
}

export interface ProviderSessionFacts {
  readonly id: ProviderSessionId;
  readonly providerNativeSessionId: string;
  readonly discovered: boolean;
}

/**
 * Exactly what the Runtime asks of Agents, and nothing more. Notably absent:
 * anything that creates or edits a role.
 */
export interface AgentsPort {
  authoriseSpawn(
    principal: AuthenticatedPrincipal,
    input: {
      readonly roleProfileId: AgentRoleProfileId;
      readonly callerAgentRunId?: AgentRunId;
      readonly callerAgentId?: AgentId;
    },
  ): Promise<B3Result<SpawnAuthorityFacts>>;

  authoriseRunOperation(
    principal: AuthenticatedPrincipal,
    input: {
      readonly targetAgentId: AgentId;
      readonly operation: 'interrupt' | 'stop-one' | 'stop-tree' | 'adopt' | 'continue' | 'control';
    },
  ): Promise<B3Result<{ readonly grantId?: DelegationGrantId }>>;

  createAgentFromRole(
    context: CommandContext,
    input: {
      readonly roleProfileId: AgentRoleProfileId;
      readonly displayName: string;
      readonly rootHumanPrincipalId: HumanPrincipalId;
      readonly parentAgentId?: AgentId;
      readonly creatingRunId?: AgentRunId;
    },
  ): Promise<B3Result<{ readonly agent: AgentFacts }>>;

  resolveLaunchPlan(
    context: CommandContext,
    input: {
      readonly agentId: AgentId;
      readonly configurationMode: LaunchConfigurationMode;
      readonly inheritedPlanId?: ResolvedLaunchPlanId;
      readonly replacementPlanId?: ControlReplacementPlanId;
      readonly requestedProvider?: 'claude' | 'codex' | 'kimi';
      readonly requestedModelId?: string;
      readonly requestedEffort?: string;
      readonly workingDirectory: string;
      readonly supervised: boolean;
    },
  ): Promise<B3Result<LaunchPlanFacts>>;

  getLaunchPlan(
    principal: AuthenticatedPrincipal, launchPlanId: ResolvedLaunchPlanId,
  ): Promise<B3Result<LaunchPlanFacts>>;

  getAgent(
    principal: AuthenticatedPrincipal, agentId: AgentId,
  ): Promise<B3Result<AgentFacts>>;

  /**
   * This Agent's children, each with the edge that made it. One seam, not two:
   * a caller that only wants ids takes them off the edges, and the tree that
   * must PUBLISH the edges (§12.7) does not need a second question.
   */
  listChildRelationships(
    principal: AuthenticatedPrincipal, parentAgentId: AgentId,
  ): Promise<B3Result<readonly AgentRelationshipFacts[]>>;

  /** Who spawned this Agent. Immutable history, owned by Agents (red gate 9). */
  parentAgentIdOf(
    principal: AuthenticatedPrincipal, agentId: AgentId,
  ): Promise<B3Result<AgentId | null>>;

  /** Every generation's authority, issued against the Run it dies with. */
  issueDelegationGrant(
    context: CommandContext,
    input: {
      readonly issuerAgentRunId: AgentRunId;
      readonly subjectAgentId: AgentId;
      readonly targetAgentIds: readonly AgentId[];
      readonly requestedScopes: readonly AuthorityScope[];
      readonly requestedChildRoleIds: readonly AgentRoleProfileId[];
    },
  ): Promise<B3Result<{ readonly id: DelegationGrantId }>>;

  expireGrantsOfRun(
    agentRunId: AgentRunId,
  ): Promise<B3Result<{ readonly expired: readonly DelegationGrantId[] }>>;

  /** What this provider can actually change on a live Run, and how honestly. */
  discoverAgentControls(
    principal: AuthenticatedPrincipal,
    input: {
      readonly agentRunId: AgentRunId;
      readonly launchPlanId: ResolvedLaunchPlanId;
      readonly delegationGrantId?: DelegationGrantId;
    },
  ): Promise<B3Result<ControlCapabilityFacts>>;

  /**
   * Change one. The Runtime supplies the Run facts because it owns the Run;
   * Agents decides whether the role and the provider allow it, because it owns
   * the role. Neither half can answer alone, which is why this is a port call
   * and not a re-derivation on either side (red gate 6).
   */
  applyAgentControl(
    context: CommandContext,
    input: {
      readonly agentRunId: AgentRunId;
      readonly agentId: AgentId;
      readonly launchPlanId: ResolvedLaunchPlanId;
      readonly providerSessionId: ProviderSessionId;
      readonly expectedRunVersion: RecordVersion;
      readonly delegationGrantId?: DelegationGrantId;
      readonly control: AgentControlFacts;
    },
  ): Promise<B3Result<AgentControlOutcomeFacts>>;

  registerProviderSession(
    input: {
      readonly expectedProviderSessionId: ProviderSessionId;
      readonly agentId: AgentId;
      readonly provider: 'claude' | 'codex' | 'kimi';
      readonly providerConversationId: string | null;
      readonly providerResumeHandle: string | null;
      readonly discovery:
        | { readonly state: 'discovered' }
        | { readonly state: 'failed-before-discovery'; readonly reason: string };
    },
  ): Promise<B3Result<ProviderSessionFacts>>;

  getProviderSession(
    principal: AuthenticatedPrincipal, providerSessionId: ProviderSessionId,
  ): Promise<B3Result<ProviderSessionFacts>>;

  continuationAllowed(
    principal: AuthenticatedPrincipal,
    input: { readonly launchPlanId: ResolvedLaunchPlanId; readonly mode: ContinuationMode },
  ): Promise<B3Result<null>>;

  getControlReplacementPlan(
    principal: AuthenticatedPrincipal, planId: ControlReplacementPlanId,
  ): Promise<B3Result<{
    readonly agentId: AgentId;
    readonly expectedOldRunId: AgentRunId;
    readonly proposedLaunchPlanId: ResolvedLaunchPlanId;
  }>>;
}

// ── What Terminal must answer ───────────────────────────────────────────────

export interface ManagedTerminalRequest {
  readonly agentRunId: AgentRunId;
  readonly launchAuthorityRef: string;
  readonly launchFingerprint: string;
  readonly workingDirectory: string;
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalFacts {
  readonly id: TerminalSessionId;
  readonly status: 'reserved' | 'starting' | 'live' | 'exited' | 'failed' | 'recovery-required';
}

/**
 * Terminal, seen through the one hole the Runtime needs: open a managed PTY,
 * type into it under the Runtime's own authority, read what came back, name the
 * active turn so an interrupt barrier can be judged, and stop it.
 */
export interface TerminalPort {
  openManagedTerminal(
    context: CommandContext, input: ManagedTerminalRequest,
  ): Promise<B3Result<TerminalFacts>>;

  /**
   * Submit one turn as the Runtime, not as a controller. Returns `false` when
   * the bytes were accepted but the outcome is unconfirmed, which is a
   * different fact from failure (§20's `submitted-unconfirmed`).
   */
  submitRuntimeInput(
    context: CommandContext,
    input: {
      readonly terminalSessionId: TerminalSessionId;
      /** The whole turn, in the order it must be typed, under one lease. */
      readonly keystrokes: readonly TurnDeliveryStep[];
      readonly effectKey: string;
    },
  ): Promise<B3Result<{ readonly confirmed: boolean }>>;

  /** Everything the session has printed, for the gate to read its reply from. */
  readOutputSoFar(
    principal: AuthenticatedPrincipal, terminalSessionId: TerminalSessionId,
  ): Promise<B3Result<string>>;

  beginProviderTurn(
    input: {
      readonly terminalSessionId: TerminalSessionId;
      readonly agentRunId: AgentRunId;
      readonly providerTurnId: ProviderTurnId;
      readonly activityGeneration: ActivityGeneration;
    },
  ): Promise<B3Result<null>>;

  endProviderTurn(
    input: {
      readonly terminalSessionId: TerminalSessionId;
      readonly providerTurnId: ProviderTurnId;
    },
  ): Promise<B3Result<null>>;

  /** §13.3's compare-and-set barrier against the exact active turn tuple. */
  interruptTurn(
    input: {
      readonly terminalSessionId: TerminalSessionId;
      readonly agentRunId: AgentRunId;
      readonly providerTurnId: ProviderTurnId;
      readonly activityGeneration: ActivityGeneration;
      readonly expectedRuntimeEpochId: RuntimeEpochId;
    },
  ): Promise<B3Result<
    | { readonly kind: 'barrier-committed'; readonly providerTurnId: ProviderTurnId }
    | { readonly kind: 'target-turn-not-active' }
    | { readonly kind: 'raced-with-completion'; readonly providerTurnId: ProviderTurnId }
  >>;

  terminate(
    input: {
      readonly terminalSessionId: TerminalSessionId;
      readonly agentRunId: AgentRunId;
      readonly expectedRuntimeEpochId: RuntimeEpochId;
      readonly reason: 'stop-one' | 'stop-tree' | 'spawn-compensation';
    },
  ): Promise<B3Result<null>>;

  getTerminal(
    principal: AuthenticatedPrincipal, terminalSessionId: TerminalSessionId,
  ): Promise<B3Result<TerminalFacts | null>>;
}

// ── What a provider must answer ─────────────────────────────────────────────

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

/**
 * How a spawned Agent authenticates as ITSELF from inside its own PTY
 * (DEC-B3V4-05). The Runtime hands the child a run id and a secret derived
 * from it; the transport re-derives and compares. No caller-supplied identity
 * is ever trusted, and nothing durable has to be written to make it work.
 */
export interface RunCredentialPort {
  issue(agentRunId: AgentRunId): Readonly<Record<string, string>>;
  verify(agentRunId: AgentRunId, token: string): boolean;
}

export interface RuntimeSurfaceHints {
  readonly launchSurface: LaunchSurface;
}

// ── What Messaging must answer ──────────────────────────────────────────────

/**
 * The Messaging endpoint lifecycle, seen through the four questions the spawn
 * and continuation ladders actually ask (§13.5 rows 6/10, §13.6).
 *
 * Narrow on purpose. The Runtime cannot send a Message, cannot read an inbox,
 * and cannot open a conversation through this port — it can only reserve,
 * activate, drain and transfer the claim that says WHICH Run currently owns an
 * Agent's terminal, which is the only Messaging fact a Run lifecycle owns.
 */
export interface MessagingEndpointPort {
  /**
   * The Thread this Agent's own conversation lives in, get-or-create.
   *
   * Needed because a Transcript binding cannot exist without one (§12.5:
   * every mirrored turn commits into a Thread) and nothing else in the spawn
   * ladder holds a Thread id.
   */
  ensureAgentThread(
    input: {
      readonly agentId: AgentId;
      readonly rootHumanPrincipalId: HumanPrincipalId;
    },
  ): Promise<B3Result<{ readonly threadId: string }>>;

  /** The Agent's current claim, or the empty generation when it has none. */
  currentEndpoint(
    agentId: AgentId,
  ): Promise<B3Result<{
    readonly claimId: string | null;
    readonly endpointGeneration: number;
    /**
     * Which Run holds it. A caller closing ITS OWN endpoint has to be able to
     * tell — draining a claim a successor already took would silence a live
     * Agent, and the claim id alone does not say whose it is.
     */
    readonly agentRunId?: string;
  }>>;

  reserve(
    input: {
      readonly agentId: AgentId;
      readonly agentRunId: AgentRunId;
      readonly terminalSessionId: TerminalSessionId;
      readonly expectedEndpointGeneration: number;
    },
  ): Promise<B3Result<{ readonly claimId: string; readonly endpointGeneration: number }>>;

  activate(claimId: string): Promise<B3Result<{ readonly claimId: string }>>;

  /** §13.6: the old endpoint stops accepting new work before the transfer. */
  drain(claimId: string): Promise<B3Result<{ readonly claimId: string }>>;

  transfer(
    input: {
      readonly agentId: AgentId;
      readonly expectedOldClaimId: string;
      readonly newRunId: AgentRunId;
      readonly newTerminalSessionId: TerminalSessionId;
      readonly oldFinalTranscriptWatermark: string;
      readonly expectedEndpointGeneration: number;
    },
  ): Promise<B3Result<{ readonly claimId: string; readonly endpointGeneration: number }>>;
}

// ── What Transcript must answer ─────────────────────────────────────────────

/**
 * Transcript custody, seen through the two things a Run lifecycle owns: this
 * Run's binding is established at spawn (§13.5 row 9), and the watermark it
 * reached is committed before the endpoint moves on (§13.6's "final transcript
 * watermark committed").
 *
 * Separate from `TranscriptBindingLookup`, which is the §19.1 read a Run VIEW
 * makes. This one mutates; that one does not.
 */
export interface TranscriptCustodyPort {
  bind(
    input: {
      readonly agentId: AgentId;
      readonly agentRunId: AgentRunId;
      readonly provider: 'claude' | 'codex' | 'kimi';
      readonly providerSessionId: ProviderSessionId;
      readonly threadId: string;
    },
  ): Promise<B3Result<{
    readonly bindingId: string;
    readonly mirrorWatermark?: string;
  }>>;

  /**
   * How far this Run's mirror durably got. The empty string is a real answer —
   * a Run that produced no transcript position has no watermark, and inventing
   * one would let a transfer claim a position nothing ever committed.
   */
  finalWatermarkOf(agentRunId: AgentRunId): Promise<B3Result<{
    readonly bindingId: string | null;
    readonly finalWatermark: string;
  }>>;
}
