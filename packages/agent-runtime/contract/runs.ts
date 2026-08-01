// Agent Runtime's durable records (B3V4-P2 §6).
//
// An Agent is a person; a Run is one of its shifts (DEC-B3V4-02). Everything
// here describes a shift: what it is doing, what replaced it, who supervises it,
// and — the load-bearing one — the journal that lets an interrupted spawn be
// resumed rather than repeated.
//
// Agent Runtime is the sole writer of all five (§3.3).
import type {
  ActivityGeneration, AgentId, AgentRunId, CommandReceiptId, HumanPrincipalId,
  IsoUtc, ProviderSessionId, ProviderTurnId, RecordEnvelope, ResolvedLaunchPlanId,
  RunContinuationId, RunOperationId, RuntimeEpochId, SupervisionAssignmentId,
  TerminalSessionId, TraceCorrelationId, TreeMutationFenceId, B3PrincipalId,
} from '@novakai/foundation/contract';

// ── The Run (§6.1) ──────────────────────────────────────────────────────────

export const AGENT_RUN_LIFECYCLES = [
  'provisioning', 'ready', 'interrupted', 'continuation-pending',
  'stopping', 'stopped', 'failed', 'recovery-required',
] as const;
export type AgentRunLifecycle = typeof AGENT_RUN_LIFECYCLES[number];

export const AGENT_RUN_ACTIVITIES = [
  'idle', 'working', 'waiting-provider', 'waiting-input', 'interrupting', 'unknown',
] as const;
export type AgentRunActivity = typeof AGENT_RUN_ACTIVITIES[number];

export type RunFinalReason =
  | 'explicit-stop' | 'explicit-tree-stop' | 'task-completion-policy'
  | 'provider-exit' | 'runtime-reconciled-missing' | 'spawn-compensation'
  | 'replaced-by-continuation' | 'unrecoverable-failure';

/**
 * Something this Run cannot honestly claim to know. Carried in the record so a
 * reader is never handed a confident answer that was actually a guess
 * (red gate 27).
 */
export interface RunUncertainty {
  readonly code:
    | 'provider-liveness-unknown' | 'terminal-input-unconfirmed'
    | 'usage-partial' | 'transcript-waiting' | 'cleanup-incomplete';
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

/** The tuple a lifecycle interrupt may target (§13.3). Never just an id. */
export interface ActiveProviderTurn {
  readonly providerTurnId: ProviderTurnId;
  readonly activityGeneration: ActivityGeneration;
  readonly startedAt: IsoUtc;
  readonly state: 'working' | 'waiting-provider' | 'interrupting';
}

export const LAUNCH_SURFACES = [
  'novakai-shell', 'external-terminal', 'agent', 'script', 'operations',
] as const;
export type LaunchSurface = typeof LAUNCH_SURFACES[number];

export interface AgentRun extends RecordEnvelope<AgentRunId, 'agentRun'> {
  readonly agentId: AgentId;
  readonly launchPlanId: ResolvedLaunchPlanId;
  /** Minted once, before this record existed, and never rebound (§5.4). */
  readonly providerSessionId: ProviderSessionId;
  readonly terminalSessionId?: TerminalSessionId;
  readonly lifecycle: AgentRunLifecycle;
  readonly activity: AgentRunActivity;
  readonly activityGeneration: ActivityGeneration;
  readonly activeProviderTurn?: ActiveProviderTurn;
  /** Historical truth. Never inferred from who is attached now (red gate 4). */
  readonly launchSurface: LaunchSurface;
  readonly requestedBy: B3PrincipalId;
  readonly parentRequestingRunId?: AgentRunId;
  readonly rootTraceId: TraceCorrelationId;
  readonly startedAt?: IsoUtc;
  readonly finalAt?: IsoUtc;
  readonly finalReason?: RunFinalReason;
  readonly uncertainty: readonly RunUncertainty[];
}

/** `stopped`, `failed` and reconciled `interrupted` are the end of a shift. */
export const FINAL_LIFECYCLES: ReadonlySet<AgentRunLifecycle> =
  new Set<AgentRunLifecycle>(['stopped', 'failed', 'interrupted']);

// ── Continuation, supervision, tree fence (§6.2) ────────────────────────────

export const CONTINUATION_MODES = ['resume', 'fresh', 'compact', 'handover'] as const;
export type ContinuationMode = typeof CONTINUATION_MODES[number];

export const LAUNCH_CONFIGURATION_MODES = [
  'inherit-plan', 'refresh-role', 'signed-control-replacement',
] as const;
export type LaunchConfigurationMode = typeof LAUNCH_CONFIGURATION_MODES[number];

/**
 * Restarting yourself is not spawning a subordinate (DEC-B3V4-09, red gate 8).
 * A continuation is its own edge, in its own file, with its own vocabulary.
 */
export interface RunContinuation
  extends RecordEnvelope<RunContinuationId, 'runContinuation'> {
  readonly agentId: AgentId;
  readonly fromRunId: AgentRunId;
  readonly toRunId: AgentRunId;
  readonly mode: ContinuationMode;
  readonly configurationMode: LaunchConfigurationMode;
  readonly providerResumeHandleUsed: boolean;
  readonly handoverArtifactId?: string;
}

/**
 * Who looks after this Agent TODAY. Separate from who spawned it, which is
 * immutable history — adoption moves this and never that (red gate 9).
 */
export interface SupervisionAssignment
  extends RecordEnvelope<SupervisionAssignmentId, 'supervisionAssignment'> {
  readonly subjectAgentId: AgentId;
  readonly supervisor:
    | { readonly kind: 'agent'; readonly agentId: AgentId }
    | { readonly kind: 'human'; readonly principalId: HumanPrincipalId }
    | { readonly kind: 'orphaned'; readonly reason: string };
  readonly reason:
    | 'spawn-parent' | 'explicit-adoption' | 'parent-final-policy' | 'manual-human-assignment';
  readonly previousAssignmentId?: SupervisionAssignmentId;
}

/**
 * A stop-tree in progress. While this is `closing`, nothing may be spawned,
 * continued or adopted inside the subtree — otherwise the snapshot the stop is
 * working from is never complete (§13.7).
 */
export interface TreeMutationFence
  extends RecordEnvelope<TreeMutationFenceId, 'treeMutationFence'> {
  readonly rootAgentId: AgentId;
  readonly operationId: RunOperationId;
  readonly state: 'closing' | 'released' | 'recovery-required';
  readonly descendantSnapshotVersion: number;
}

// ── The recoverable journal (§6.3) ──────────────────────────────────────────

export const RUN_OPERATION_KINDS = [
  'spawn', 'continue', 'stop-one', 'stop-tree', 'adopt',
] as const;
export type RunOperationKind = typeof RUN_OPERATION_KINDS[number];

/**
 * The stage ladder. Pass 1's ORDER is normative: a stage advances only after
 * the named owner confirms a durable outcome, and recovery queries each effect
 * by its stable key before ever repeating it.
 */
export const RUN_OPERATION_STAGES = [
  'receipt-accepted', 'agent-lease-acquired', 'launch-plan-recorded',
  'relationship-recorded', 'run-reserved', 'endpoint-reserved',
  'terminal-reserved', 'terminal-live', 'provider-session-recorded',
  'transcript-bound', 'endpoint-active', 'skills-gate-prompt-sent',
  'skills-gate-confirmed', 'supervised-work-released', 'watchers-installed',
  'run-ready', 'old-run-fenced', 'old-endpoint-drained', 'old-transcript-finalised',
  'old-usage-finalised', 'endpoint-transferred', 'compensating', 'completed',
  'recovery-required',
] as const;
export type RunOperationStage = typeof RUN_OPERATION_STAGES[number];

export interface RunOperationStageOutcome {
  readonly stage: RunOperationStage;
  /** Stable across retries: how recovery finds an effect instead of redoing it. */
  readonly effectKey: string;
  readonly owner: string;
  readonly ownerObjectId?: string;
  readonly completedAt: IsoUtc;
  /**
   * Additive to §6.3: a stage that did not APPLY is recorded as `not-needed`
   * with the reason, rather than silently skipped. Two reasons exist — the
   * owning capability arrives in a later slice, or this particular Run never
   * needed it (a root Agent has no family edge to record). A gap in the ladder
   * that nobody wrote down is how a later slice discovers it was never wired.
   */
  readonly outcome?: 'completed' | 'not-needed';
  readonly notNeededBecause?: string;
}

export interface CompensationOutcome {
  readonly stage: RunOperationStage;
  readonly effectKey: string;
  readonly outcome: 'not-needed' | 'succeeded' | 'failed' | 'uncertain';
  readonly reason?: string;
}

export interface RunOperation extends RecordEnvelope<RunOperationId, 'runOperation'> {
  readonly kindOfOperation: RunOperationKind;
  readonly commandReceiptId: CommandReceiptId;
  readonly runtimeEpochId: RuntimeEpochId;
  readonly agentId?: AgentId;
  readonly oldRunId?: AgentRunId;
  readonly newRunId?: AgentRunId;
  /**
   * Required from the FIRST persisted record for spawn and continue. A crash
   * before the Run exists therefore recovers the same reservation instead of
   * minting a second provider session (§5.4, §20).
   */
  readonly reservedProviderSessionId?: ProviderSessionId;
  readonly currentStage: RunOperationStage;
  readonly completedStages: readonly RunOperationStageOutcome[];
  readonly compensation: readonly CompensationOutcome[];
  readonly state:
    | 'running' | 'continuation-pending' | 'tree-stop-pending'
    | 'completed' | 'recovery-required';
  /** Per-Agent results for a tree stop, so a partial failure is inspectable. */
  readonly perAgentOutcomes?: readonly {
    readonly agentId: AgentId;
    readonly agentRunId?: AgentRunId;
    readonly outcome: 'pending' | 'succeeded' | 'failed' | 'uncertain';
    readonly reason?: string;
  }[];
}
