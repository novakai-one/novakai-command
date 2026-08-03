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
  HumanPrincipalId, ProviderSessionId, ProviderTurnId, ActivityGeneration, IsoUtc,
  NotificationId, NotificationInputReservationId, RecordVersion,
  ResolvedLaunchPlanId, RuntimeEpochId, TerminalInputAttemptId, TerminalInputLeaseId,
  TerminalSessionId, TranscriptBindingId, TranscriptTurnCompletionId,
  ProviderTurnSubmissionId, ProviderUsageEvidenceId, ProviderTurnBoundaryProfileId,
} from '@novakai/foundation/contract';
import type { ContinuationMode, LaunchConfigurationMode, LaunchSurface } from './runs.js';
import type { TurnDeliveryStep } from './types.js';
import type {
  AgentControlFacts, AgentControlOutcomeFacts, ControlCapabilityFacts,
} from './controls.js';
import type { AgentRelationshipFacts } from './family.js';
import type { LaunchPlanFacts } from './launch-facts.js';

export type {
  AgentControlFacts, AgentControlOutcomeFacts, AgentRelationshipFacts,
  ControlCapabilityFacts,
};
export type {
  NotificationDeliveryAuthorityFacts, NotificationDeliveryClaimFacts,
  NotificationDeliveryPort, NotificationDeliveryStateFacts,
} from './notification-delivery.js';

// ── What Agents must answer ─────────────────────────────────────────────────

// `LaunchPlanFacts` is in `launch-facts.ts` — the one fact both the Agents seam
// and the provider seam speak about. Re-exported so consumers see one contract.
export type { LaunchPlanFacts };

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
  readonly provider: 'claude' | 'codex' | 'kimi';
  readonly providerConversationId: string | null;
  readonly providerVersion: string;
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
      readonly providerVersion: string;
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

export interface NotificationInputReservationFacts {
  readonly id: NotificationInputReservationId;
  readonly terminalSessionId: TerminalSessionId;
  readonly agentRunId: AgentRunId;
  readonly notificationId: NotificationId;
  readonly deliveryEffectKey: string;
  readonly expectedActivityGeneration: ActivityGeneration;
  readonly providerTurnId: ProviderTurnId;
  readonly state: 'reserved' | 'cancelled' | 'committed';
  readonly terminalInputAttemptId?: TerminalInputAttemptId;
  readonly endedAt?: IsoUtc;
}

export interface NotificationInputAttemptFacts {
  readonly id: TerminalInputAttemptId;
  readonly notificationInputReservationId: NotificationInputReservationId;
  readonly deliveryEffectKey: string;
  readonly providerTurnId: ProviderTurnId;
  readonly outcome: 'submitted-confirmed' | 'submitted-unconfirmed';
  readonly submittedAt: IsoUtc;
}

export interface ProviderTurnInputAttemptFacts {
  readonly id: TerminalInputAttemptId;
  readonly recordVersion: RecordVersion;
  readonly terminalSessionId: TerminalSessionId;
  readonly agentRunId: AgentRunId;
  readonly providerTurnSubmissionId: ProviderTurnSubmissionId;
  readonly deliveryAttemptOrdinal: number;
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
  readonly submissionEffectKey: string;
  readonly providerSessionId: ProviderSessionId;
  readonly transcriptBindingId: TranscriptBindingId;
  readonly inputSequence: number;
  readonly payloadDigest: string;
  readonly authority:
    | {
        readonly kind: 'controller';
        readonly resumeDeadlineAt: IsoUtc;
      }
    | { readonly kind: 'runtime-safe-boundary' };
  readonly effectState:
    | { readonly kind: 'prepared'; readonly preparedAt: IsoUtc }
    | { readonly kind: 'executing'; readonly executionStartedAt: IsoUtc }
    | { readonly kind: 'submitted-confirmed'; readonly submittedAt: IsoUtc }
    | { readonly kind: 'submitted-unconfirmed'; readonly submittedAt: IsoUtc; readonly reason: string }
    | { readonly kind: 'rejected'; readonly rejectedAt: IsoUtc; readonly effectEscaped: false; readonly reason: string };
  readonly turnBarrier:
    | { readonly kind: 'reserved-pre-effect' }
    | { readonly kind: 'active'; readonly activatedAt: IsoUtc }
    | { readonly kind: 'interrupt-committed'; readonly barrierCommittedAt: IsoUtc }
    | {
        readonly kind: 'completion-committed';
        readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
        readonly providerUsageEvidenceId: ProviderUsageEvidenceId;
        readonly interruptDisposition: 'no-barrier' | 'barrier-won-before-completion';
      }
    | { readonly kind: 'released-rejected'; readonly releasedAt: IsoUtc }
    | { readonly kind: 'closed-unproven'; readonly closedAt: IsoUtc };
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
  ): Promise<B3Result<{
    readonly confirmed: boolean;
    readonly terminalInputAttemptId: TerminalInputAttemptId;
    readonly submittedAt: IsoUtc;
  }>>;

  reserveNotificationInput(input: {
    readonly terminalSessionId: TerminalSessionId;
    readonly agentRunId: AgentRunId;
    readonly notificationId: NotificationId;
    readonly effectKey: string;
    readonly expectedActivityGeneration: ActivityGeneration;
    readonly inputTextDigest: string;
    readonly providerTurnId: ProviderTurnId;
  }): Promise<B3Result<NotificationInputReservationFacts>>;

  commitReservedNotificationInput(input: {
    readonly notificationInputReservationId: NotificationInputReservationId;
    readonly effectKey: string;
    readonly utf8Text: string;
  }): Promise<B3Result<{
    readonly reservation: NotificationInputReservationFacts;
    readonly attempt: NotificationInputAttemptFacts;
  }>>;

  cancelReservedNotificationInput(input: {
    readonly notificationInputReservationId: NotificationInputReservationId;
    readonly effectKey: string;
    readonly reason: 'supervision-claim-rejected' | 'runtime-compensation';
  }): Promise<B3Result<NotificationInputReservationFacts>>;

  getNotificationInputReservation(
    notificationInputReservationId: NotificationInputReservationId,
  ): Promise<B3Result<NotificationInputReservationFacts | null>>;

  getNotificationInputAttempt(
    terminalInputAttemptId: TerminalInputAttemptId,
  ): Promise<B3Result<NotificationInputAttemptFacts | null>>;

  prepareProviderTurnInput(input: {
    readonly terminalSessionId: TerminalSessionId;
    readonly agentRunId: AgentRunId;
    readonly providerTurnSubmissionId: ProviderTurnSubmissionId;
    readonly deliveryAttemptOrdinal: number;
    readonly providerSessionId: ProviderSessionId;
    readonly transcriptBindingId: TranscriptBindingId;
    readonly startTranscriptWatermark: string | null;
    readonly expectedRunRecordVersion: RecordVersion;
    readonly providerTurnId: ProviderTurnId;
    readonly activityGeneration: ActivityGeneration;
    readonly submissionEffectKey: string;
    readonly inputDigest: string;
    readonly utf8Text: string;
    readonly authority:
      | {
          readonly kind: 'controller';
          readonly attachmentId: import('@novakai/foundation/contract').ControllerAttachmentId;
          readonly inputLeaseId: TerminalInputLeaseId;
          readonly leaseGeneration: import('@novakai/foundation/contract').LeaseGeneration;
          readonly expectedNextInputSequence: number;
          readonly requestingPrincipalId: import('@novakai/foundation/contract').B3PrincipalId;
        }
      | {
          readonly kind: 'runtime-safe-boundary';
          readonly source: import('@novakai/foundation/contract').ProviderTurnSubmissionSource;
          readonly sourceEffectKey: string;
          readonly sourceObjectRef: string;
          readonly expectedNoActiveInputLease: true;
          readonly expectedNoControllerDraft: true;
        };
  }): Promise<B3Result<
    | { readonly kind: 'prepared'; readonly attempt: ProviderTurnInputAttemptFacts }
    | {
        readonly kind: 'not-yet-safe';
        readonly blocking:
          | { readonly kind: 'active-input-lease'; readonly leaseId: TerminalInputLeaseId }
          | { readonly kind: 'controller-draft' }
          | { readonly kind: 'active-provider-turn' };
        readonly retryable: true;
        readonly attemptCreated: false;
        readonly inputChanged: false;
      }
  >>;

  executeProviderTurnInput(input: {
    readonly terminalInputAttemptId: TerminalInputAttemptId;
    readonly expectedAttemptRecordVersion: RecordVersion;
    readonly submissionEffectKey: string;
    readonly providerTurnId: ProviderTurnId;
    readonly activityGeneration: ActivityGeneration;
    readonly utf8Text: string;
  }): Promise<B3Result<ProviderTurnInputAttemptFacts>>;

  cancelPreparedProviderTurnInput(input: {
    readonly terminalInputAttemptId: TerminalInputAttemptId;
    readonly expectedAttemptRecordVersion: RecordVersion;
    readonly reason: 'run-target-changed' | 'runtime-preparation-rejected';
  }): Promise<B3Result<ProviderTurnInputAttemptFacts>>;

  getProviderTurnInputAttempt(input: {
    readonly terminalSessionId: TerminalSessionId;
    readonly providerTurnId: ProviderTurnId;
    readonly submissionEffectKey: string;
  }): Promise<B3Result<ProviderTurnInputAttemptFacts | null>>;

  listIncompleteProviderTurnInputAttempts(input: {
    readonly terminalSessionId?: TerminalSessionId;
    readonly agentRunId?: AgentRunId;
  }): Promise<B3Result<readonly ProviderTurnInputAttemptFacts[]>>;

  settleProviderTurnCompletion(input: {
    readonly terminalInputAttemptId: TerminalInputAttemptId;
    readonly agentRunId: AgentRunId;
    readonly providerTurnId: ProviderTurnId;
    readonly activityGeneration: ActivityGeneration;
    readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
    readonly providerUsageEvidenceId: ProviderUsageEvidenceId;
  }): Promise<B3Result<
    | {
        readonly kind: 'completion-barrier-committed' | 'already-settled-same-completion';
        readonly attemptRecordVersion: RecordVersion;
        readonly interruptDisposition: 'no-barrier' | 'barrier-won-before-completion';
      }
    | { readonly kind: 'target-turn-not-active'; readonly inputLeaseChanged: false }
  >>;

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
// In `provider-ports.ts` — the one seam that varies by provider.
export type { ProviderLaunchFacts, ProviderPort } from './provider-ports.js';


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

// ── What Messaging and Transcript must answer ───────────────────────────────
// Both live in `custody-ports.ts`; re-exported here so the contract's public
// surface is one import for every consumer.
export type {
  MessagingEndpointPort, MessagingInboxPort, RunWatcherPort, TranscriptCustodyPort,
} from './custody-ports.js';
