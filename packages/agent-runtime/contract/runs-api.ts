// The Agent Runtime public contract (B3V4-P2 §12.2). This is the only door.
//
// One spawn operation serves human, Agent and script (DEC-B3V4-04). One
// interrupt, one stop, one stop-tree, one continue, one adopt — because "similar
// callers use different policy paths" is red gate 23, and the cheapest way to
// hold that gate is to have exactly one path.
import type {
  AgentId, AgentRunId, AuthenticatedPrincipal, B3Page, B3Result, CommandContext,
  ControlReplacementPlanId, EventCursor, HumanPrincipalId, IsoUtc,
  ProviderSessionId, ProviderTurnId, ActivityGeneration, RecordVersion,
  AgentRoleProfileId, ResolvedLaunchPlanId, RunOperationId,
} from '@novakai/foundation/contract';
import type {
  AgentRun, AgentRunLifecycle, ContinuationMode, LaunchConfigurationMode,
  LaunchSurface, RunOperation, SupervisionAssignment,
} from './runs.js';

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface SpawnAgentInput {
  readonly roleProfileId: AgentRoleProfileId;
  readonly displayName: string;
  readonly requestedProvider?: 'claude' | 'codex' | 'kimi';
  readonly requestedModelId?: string;
  readonly requestedEffort?: string;
  readonly workingDirectory: string;
  /**
   * Supervised work is the case the two-turn gate exists for. Its absence means
   * an interactive chat launch — the ONLY case a disabled gate is legal in.
   */
  readonly task?: { readonly kind: 'supervised'; readonly brief: string };
  readonly columns?: number;
  readonly rows?: number;
}

export interface InterruptAgentTurnInput {
  readonly agentRunId: AgentRunId;
  readonly expectedRecordVersion: RecordVersion;
}

export type InterruptAgentTurnOutcome =
  | {
      readonly kind: 'interrupted';
      readonly agentRunId: AgentRunId;
      readonly providerTurnId: ProviderTurnId;
      readonly activityGeneration: ActivityGeneration;
      readonly inputLeaseRevoked: boolean;
    }
  | {
      readonly kind: 'not-working';
      readonly agentRunId: AgentRunId;
      readonly activityGeneration: ActivityGeneration;
      readonly inputLeaseChanged: false;
    }
  | {
      readonly kind: 'raced-with-completion';
      readonly agentRunId: AgentRunId;
      readonly providerTurnId: ProviderTurnId;
      readonly inputLeaseRevoked: true;
    };

export interface StopAgentInput {
  readonly agentId: AgentId;
  readonly expectedLiveRunId: AgentRunId;
  /** Typed on purpose: a stop is never a side effect of something else. */
  readonly confirmation: 'stop-one';
}

export interface PrepareStopAgentTreeInput {
  readonly rootAgentId: AgentId;
}

export interface StopTreeConfirmation {
  readonly rootAgentId: AgentId;
  readonly visibleDescendantCount: number;
  readonly confirmationToken: string;
  readonly expiresAt: IsoUtc;
}

export interface StopAgentTreeInput {
  readonly rootAgentId: AgentId;
  /** Issued by `prepareStopAgentTree` over the tree the caller was SHOWN. */
  readonly confirmationToken: string;
  readonly confirmation: 'stop-tree';
}

export interface ContinueAgentInput {
  readonly agentId: AgentId;
  readonly expectedOldRunId: AgentRunId;
  readonly mode: ContinuationMode;
  readonly configurationMode: LaunchConfigurationMode;
  readonly replacementPlanId?: ControlReplacementPlanId;
  readonly handoverArtifactId?: string;
}

export interface AdoptAgentInput {
  readonly subjectAgentId: AgentId;
  readonly expectedAssignmentVersion: RecordVersion;
  readonly supervisor:
    | { readonly kind: 'agent'; readonly agentId: AgentId }
    | { readonly kind: 'human'; readonly principalId: HumanPrincipalId };
}

export interface ListAgentRunsFilter {
  readonly lifecycle?: readonly AgentRunLifecycle[];
  readonly agentId?: AgentId;
  readonly launchSurface?: LaunchSurface;
  readonly includeFinal: boolean;
  readonly limit?: number;
}

export interface GetAgentRunTreeInput {
  readonly rootAgentId: AgentId;
  readonly maxDepth: number;
}

// ── Views (§19.1) ───────────────────────────────────────────────────────────

/**
 * What Chris reads. Launch origin and current attachments are SEPARATE fields
 * because "no controller attached" and "started externally" are different facts
 * from "stopped" (red gate 4, §24.5).
 */
export interface AgentRunView {
  readonly agent: {
    readonly agentId: AgentId;
    readonly displayName: string;
    readonly roleProfileId: AgentRoleProfileId;
  };
  readonly run: AgentRun;
  readonly provider: {
    readonly provider: 'claude' | 'codex' | 'kimi';
    readonly modelId: string;
    readonly effort: string;
    readonly providerSessionId: ProviderSessionId;
  };
  readonly launch: {
    readonly surface: LaunchSurface;
    readonly requestedBy: string;
    readonly startedAt?: IsoUtc;
  };
  readonly family: {
    readonly parentAgentId?: AgentId;
    readonly childCount: number;
    readonly supervisor: SupervisionAssignment['supervisor'];
  };
  /**
   * Present as a NAMED absence until B3d: a zero here would be an invented
   * measurement, which red gate 13 forbids.
   */
  readonly usage: { readonly quality: 'unavailable'; readonly reason: string };
}

export interface RunOperationView {
  readonly operation: RunOperation;
  readonly perAgentOutcomes: readonly {
    readonly agentId: AgentId;
    readonly agentRunId?: AgentRunId;
    readonly outcome: 'pending' | 'succeeded' | 'failed' | 'uncertain';
    readonly reason?: string;
  }[];
}

export interface AgentRunTreeView {
  readonly rootAgentId: AgentId;
  readonly nodes: readonly AgentRunView[];
  readonly generatedAt: IsoUtc;
}

export interface RunEvent {
  readonly eventId: string;
  readonly kind: string;
  readonly schemaVersion: 1;
  readonly occurredAt: IsoUtc;
  readonly sourceOwner: 'agent-runtime';
  readonly cursor: EventCursor;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ── The contract ────────────────────────────────────────────────────────────

export interface AgentRuntimeCommands {
  /** The ONE spawn operation — human, Agent and script all arrive here. */
  spawnAgent(
    context: CommandContext, input: SpawnAgentInput,
  ): Promise<B3Result<AgentRunView>>;

  interruptAgentTurn(
    context: CommandContext, input: InterruptAgentTurnInput,
  ): Promise<B3Result<InterruptAgentTurnOutcome>>;

  stopAgent(
    context: CommandContext, input: StopAgentInput,
  ): Promise<B3Result<AgentRunView>>;

  prepareStopAgentTree(
    context: CommandContext, input: PrepareStopAgentTreeInput,
  ): Promise<B3Result<StopTreeConfirmation>>;

  stopAgentTree(
    context: CommandContext, input: StopAgentTreeInput,
  ): Promise<B3Result<RunOperationView>>;

  continueAgent(
    context: CommandContext, input: ContinueAgentInput,
  ): Promise<B3Result<AgentRunView>>;

  adoptAgent(
    context: CommandContext, input: AdoptAgentInput,
  ): Promise<B3Result<SupervisionAssignment>>;

  /**
   * A provider turn began (§13.2). Activity is Runtime-authoritative, so
   * SOMETHING has to commit it: the gate when it submits a turn, and the
   * transport when a controller's input reaches a managed terminal.
   *
   * Without this the interrupt barrier has no tuple to target and §13.3 is
   * unreachable code — a turn nobody recorded cannot be interrupted.
   */
  beginProviderTurn(
    context: CommandContext,
    input: { readonly agentRunId: AgentRunId; readonly expectedRecordVersion: RecordVersion },
  ): Promise<B3Result<AgentRunView>>;

  /** That turn ended. Activity returns to idle and the tuple is cleared. */
  endProviderTurn(
    context: CommandContext,
    input: { readonly agentRunId: AgentRunId; readonly providerTurnId: ProviderTurnId },
  ): Promise<B3Result<AgentRunView>>;

  /** Resume an operation an earlier attempt left in the middle (§20). */
  repairRunOperation(
    context: CommandContext, operationId: RunOperationId,
  ): Promise<B3Result<RunOperationView>>;
}

export interface AgentRuntimeQueries {
  getAgentRun(
    principal: AuthenticatedPrincipal, agentRunId: AgentRunId,
  ): Promise<B3Result<AgentRunView>>;

  listAgentRuns(
    principal: AuthenticatedPrincipal, filter: ListAgentRunsFilter,
  ): Promise<B3Result<B3Page<AgentRunView>>>;

  getAgentRunTree(
    principal: AuthenticatedPrincipal, input: GetAgentRunTreeInput,
  ): Promise<B3Result<AgentRunTreeView>>;

  getRunOperation(
    principal: AuthenticatedPrincipal, operationId: RunOperationId,
  ): Promise<B3Result<RunOperationView>>;

  /**
   * Every operation, or only the ones an earlier epoch left unfinished.
   *
   * Boot recovery wants the unfinished set. Chris wants "what did that spawn
   * actually do", which is the same ladder read after it succeeded. One query,
   * because they are the same question asked at different times.
   */
  listRunOperations(
    principal: AuthenticatedPrincipal,
    filter?: { readonly includeCompleted?: boolean },
  ): Promise<B3Result<readonly RunOperationView[]>>;
}

export type AgentRunsContract = AgentRuntimeCommands & AgentRuntimeQueries & {
  /** Reconcile what an earlier epoch left behind. Called once, at boot. */
  reconcileAfterRestart(): Promise<B3Result<{ readonly reconciledRunIds: readonly AgentRunId[] }>>;
  /** The launch plan a Run is pinned to, for callers that need it by Run. */
  getRunLaunchPlanId(
    principal: AuthenticatedPrincipal, agentRunId: AgentRunId,
  ): Promise<B3Result<ResolvedLaunchPlanId>>;
};
