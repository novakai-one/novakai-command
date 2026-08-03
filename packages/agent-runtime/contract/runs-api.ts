// The Agent Runtime public contract (B3V4-P2 §12.2). This is the only door.
//
// One spawn operation serves human, Agent and script (DEC-B3V4-04). One
// interrupt, one stop, one stop-tree, one continue, one adopt — because "similar
// callers use different policy paths" is red gate 23, and the cheapest way to
// hold that gate is to have exactly one path.
import type {
  AgentId, AgentRunId, AuthenticatedPrincipal, B3Page, B3Result, CapabilityOwner, CommandContext,
  ControlReplacementPlanId, EventCursor, HumanPrincipalId, IsoUtc,
  ProviderSessionId, ProviderTurnId, ActivityGeneration, RecordVersion,
  AgentRoleProfileId, ResolvedLaunchPlanId, RunOperationId, TraceCorrelationId,
  SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  AgentRun, AgentRunLifecycle, ContinuationMode, LaunchConfigurationMode,
  LaunchSurface, RunOperation, SupervisionAssignment, TreeMutationFence,
} from './runs.js';
import type {
  AgentControlFacts, AgentControlOutcomeFacts, AgentRelationshipFacts,
  ControlCapabilityFacts,
} from './ports.js';
import type { AgentRunUsage } from '../../supervision/contract/index.js';
import type {
  NotificationTurnSubmission, StartNotificationTurnInput,
} from './notification-delivery.js';
import type {
  CloseProviderTurnCompletionUnprovenInput,
  CloseProviderTurnCompletionUnprovenOutcome,
  CompleteProviderTurnInput,
  CompleteProviderTurnOutcome,
  ControllerProviderTurnSubmitInput,
  ProviderTurnSubmission,
  ProviderTurnSubmissionFilter,
  ProviderTurnSubmissionPage,
  ProviderTurnSubmitOutcome,
  SystemProviderTurnSubmitInput,
} from './provider-turns.js';

export type {
  NotificationTurnSubmission, StartNotificationTurnInput,
} from './notification-delivery.js';

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

/**
 * The two facts a caller actually has: which Run, and which version of it it
 * read. Everything else a control needs — the Agent, the pinned plan, the
 * provider session — is looked up from the Run, because accepting them from
 * the request would let a caller aim a control at someone else's plan.
 */
export interface ApplyRunControlInput {
  readonly agentRunId: AgentRunId;
  readonly expectedRunVersion: RecordVersion;
  readonly control: AgentControlFacts;
}

export interface DiscoverRunControlsInput {
  readonly agentRunId: AgentRunId;
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
  /**
   * Which way to walk (§12.7). Absent means `descendants`, which is what every
   * caller before this asked for — but a caller that ASKS for ancestors and is
   * handed descendants has been lied to, and that is what the blind hold-out
   * found (D8).
   */
  readonly direction?: TreeDirection;
}

export type TreeDirection = 'ancestors' | 'descendants' | 'both';

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
    /**
     * How many times supervision has been assigned. This is the number an
     * adoption must quote as `expectedAssignmentVersion` — published here
     * because a compare-and-set whose "expected" side is unreadable from the
     * contract is not a safety mechanism (§12.2, and the same lesson B3a
     * learned about `expectedNextInputSequence`).
     */
    readonly supervisionVersion: RecordVersion;
  };
  /** Supervision-owned projection over Agents evidence for this exact Run. */
  readonly usage: AgentRunUsage;
  /**
   * §19.1's transcript section (B3c).
   *
   * `bindingState` is `unbound` when Transcript has never been asked about
   * this Run — a fourth answer beside bound/waiting/missing, and a different
   * fact from "the file is missing". Absence of a watermark means nothing has
   * been mirrored yet, which is not the same as zero.
   */
  readonly transcript: {
    readonly bindingState: 'bound' | 'waiting' | 'missing' | 'corrupt' | 'unbound';
    readonly mirrorWatermark?: string;
  };
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

/** Runtime-owned facts Supervision needs without recursively assembling a Run view. */
export interface RunUsageFacts {
  readonly agentRunId: AgentRunId;
  readonly agentId: AgentId;
  readonly providerSessionId: ProviderSessionId;
  readonly final: boolean;
}

/** Narrow composition adapter from Runtime records into Supervision projections. */
export interface RunUsageSource {
  getUsageRun(
    principal: AuthenticatedPrincipal,
    agentRunId: AgentRunId,
  ): Promise<B3Result<RunUsageFacts>>;
  listUsageRuns(
    principal: AuthenticatedPrincipal,
    agentId: AgentId,
  ): Promise<B3Result<readonly RunUsageFacts[]>>;
}

/** Supervision projection lookup used while Runtime assembles a public Run view. */
export type RunUsageLookup = (
  principal: AuthenticatedPrincipal,
  agentRunId: AgentRunId,
) => Promise<B3Result<AgentRunUsage>>;

/**
 * A Run in the family, plus the two facts that only the TREE knows: how far
 * from the queried root it sits, and who is supervising it right now (§12.7
 * `AgentTreeNode`). Supervision is repeated at node level on purpose — a
 * consumer reading a tree reads nodes, and making it dig into `family` for the
 * one field the tree contract names is the drift D9 caught.
 */
export interface AgentRunTreeNode extends AgentRunView {
  readonly depth: number;
  readonly currentSupervision: SupervisionAssignment['supervisor'];
}

export interface AgentRunTreeView {
  readonly rootAgentId: AgentId;
  readonly nodes: readonly AgentRunTreeNode[];
  /** Every parent→child edge inside the returned set (§12.7, normative). */
  readonly edges: readonly AgentRelationshipFacts[];
  readonly generatedAt: IsoUtc;
}

/** The §15 envelope, whole. A consumer reads events, not payloads. */
export interface RunEvent {
  readonly eventId: string;
  readonly kind: string;
  readonly schemaVersion: 1;
  readonly occurredAt: IsoUtc;
  readonly committedAt: IsoUtc;
  /**
   * The capability that OWNS the fact. Was pinned to `agent-runtime` while
   * the Runtime was the only publisher; B3c's messaging/transcript facts ride
   * the same stream (§15, §24.4) and naming them agent-runtime would misstate
   * who is authoritative for them.
   */
  readonly sourceOwner: CapabilityOwner;
  readonly traceId: TraceCorrelationId;
  readonly cursor: EventCursor;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RunEventPage {
  readonly events: readonly RunEvent[];
  /** Feed this back as `after` to continue exactly where this page ended. */
  readonly nextCursor: EventCursor;
}

export interface ReadRunEventsInput {
  readonly after?: EventCursor;
  readonly limit?: number;
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
   * Change one control on a live Run (§12.1, B3R-006/025). Answers natively,
   * refuses with a reason, or returns a replacement plan — never restarts an
   * Agent on its own initiative.
   */
  applyRunControl(
    context: CommandContext, input: ApplyRunControlInput,
  ): Promise<B3Result<AgentControlOutcomeFacts>>;

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

  submitProviderTurn(
    context: CommandContext,
    input: ControllerProviderTurnSubmitInput,
  ): Promise<B3Result<ProviderTurnSubmitOutcome>>;

  submitProviderTurn(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: SystemProviderTurnSubmitInput,
  ): Promise<B3Result<ProviderTurnSubmitOutcome>>;

  completeProviderTurn(
    context: SystemCommandContext<'sys_reconciler'>,
    input: CompleteProviderTurnInput,
  ): Promise<B3Result<CompleteProviderTurnOutcome>>;

  closeProviderTurnCompletionUnproven(
    context: CommandContext,
    input: CloseProviderTurnCompletionUnprovenInput,
  ): Promise<B3Result<CloseProviderTurnCompletionUnprovenOutcome>>;

  /** Resume an operation an earlier attempt left in the middle (§20). */
  repairRunOperation(
    context: CommandContext, operationId: RunOperationId,
  ): Promise<B3Result<RunOperationView>>;

  startNotificationTurnAtSafeBoundary(
    context: SystemCommandContext<'sys_supervision'>,
    input: StartNotificationTurnInput,
  ): Promise<B3Result<Extract<
    NotificationTurnSubmission,
    { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
  >>>;
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

  /** What could be changed on this Run, before anyone tries to change it. */
  discoverRunControls(
    principal: AuthenticatedPrincipal, input: DiscoverRunControlsInput,
  ): Promise<B3Result<ControlCapabilityFacts>>;

  getRunOperation(
    principal: AuthenticatedPrincipal, operationId: RunOperationId,
  ): Promise<B3Result<RunOperationView>>;

  getNotificationTurnSubmission(
    principal: AuthenticatedPrincipal, effectKey: string,
  ): Promise<B3Result<NotificationTurnSubmission>>;

  getProviderTurnSubmission(
    principal: AuthenticatedPrincipal,
    providerTurnId: ProviderTurnId,
  ): Promise<B3Result<ProviderTurnSubmission>>;

  listProviderTurnSubmissions(
    principal: AuthenticatedPrincipal,
    filter: ProviderTurnSubmissionFilter,
  ): Promise<B3Result<ProviderTurnSubmissionPage>>;

  /**
   * §12.2's event subscription: every event after `after`, live, until the
   * consumer stops reading. An expired cursor yields ONE typed gap and ends —
   * §15 forbids resuming silently at "now".
   */
  subscribeRunEvents(
    principal: AuthenticatedPrincipal, after?: EventCursor,
  ): AsyncIterable<B3Result<RunEvent>>;

  /**
   * The same stream, pulled. A request/response wire cannot hold an
   * `AsyncIterable` open, so the socket method reads a bounded page and the
   * host pushes what follows as ordinary v1 event frames (§16.1).
   */
  readRunEvents(
    principal: AuthenticatedPrincipal, input: ReadRunEventsInput,
  ): Promise<B3Result<RunEventPage>>;

  /**
   * Let another capability publish a committed fact into the ONE event stream
   * (§15, §24.4).
   *
   * B3c's `messaging.*` and `transcript.*` events are Messaging's and
   * Transcript's facts, not the Runtime's — but a consumer that had to hold a
   * second cursor for them would have no way to order the two streams against
   * each other, and §24.4's second-host proof subscribes to exactly one. So
   * the stream is shared and the event names its real owner.
   *
   * This publishes; it does not make Agent Runtime the writer of anything.
   * Events are not durable records (§18.1 registers no events file).
   */
  publishCapabilityEvent(
    kind: string, payload: Readonly<Record<string, unknown>>, sourceOwner: CapabilityOwner,
    traceId?: TraceCorrelationId,
  ): void;

  /**
   * The tree-closing fence covering this Agent, or `null` when nothing is
   * freezing it (§6.2, §13.7 step 3).
   *
   * Published because "fence" is named in B3b's exit line and was provable only
   * from inside the code: a blind consumer could see `TreeClosing` refusals but
   * could not read the fence that caused them, and a stop that only half worked
   * leaves the fence closed with no other way to notice (hold-out E9).
   */
  getTreeFence(
    principal: AuthenticatedPrincipal, input: { readonly agentId: AgentId },
  ): Promise<B3Result<TreeMutationFence | null>>;

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

  /**
   * What the Runtime is responsible for in RUN terms — counted from the durable
   * records, so a restarted Runtime reports what is on disk rather than what it
   * remembers. Without it, status could only count terminal sessions, and
   * reported `liveAgentRunCount: 0` beside three live Agents.
   */
  census(): Promise<B3Result<{
    readonly liveAgentRunCount: number;
    readonly recoveryRequiredCount: number;
    readonly recoveryRequiredRefs: readonly string[];
  }>>;
  /** The launch plan a Run is pinned to, for callers that need it by Run. */
  getRunLaunchPlanId(
    principal: AuthenticatedPrincipal, agentRunId: AgentRunId,
  ): Promise<B3Result<ResolvedLaunchPlanId>>;
};
