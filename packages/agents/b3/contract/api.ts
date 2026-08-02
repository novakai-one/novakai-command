// The governed-Agents public contract (B3V4-P2 §12.1). This is the only door.
//
// Every command takes a trusted `CommandContext` and returns a typed `Result`.
// No caller ever supplies `createdBy`, a parent identity, a root identity, or a
// widened grant — those are derived here from what the transport authenticated
// (red gate 5).
import type {
  AgentId, AgentRelationshipId, AgentRoleProfileId, AgentRunId, AuthenticatedPrincipal,
  AuthorityScope, B3Page, B3Result, CommandContext, ControlReplacementPlanId,
  DelegationGrantId, HumanPrincipalId, ProviderSessionId, RecordVersion,
  ResolvedLaunchPlanId, SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  Agent, AgentControl, AgentRelationship, AgentRoleProfile, ContinuationMode,
  ControlReplacementPlan, DelegationGrant, EnforcementLevel, ProviderKind,
  ProviderSessionView, ResolvedLaunchPlan, SupportLevel,
} from './records.js';

// ── Inputs (§12.7) ──────────────────────────────────────────────────────────

/** A role profile minus everything Foundation stamps. */
export type CreateRoleProfileInput = Omit<
  AgentRoleProfile,
  'id' | 'kind' | 'schemaVersion' | 'recordVersion' | 'createdAt'
  | 'permissionLevel' | 'createdBy' | 'lastMutation'
>;

export interface UpdateRoleProfileInput {
  readonly roleProfileId: AgentRoleProfileId;
  readonly expectedRecordVersion: RecordVersion;
  readonly replacement: CreateRoleProfileInput;
}

export interface CreateAgentFromRoleInput {
  readonly roleProfileId: AgentRoleProfileId;
  readonly displayName: string;
  /** Trusted, Runtime-derived. A request body may not claim it. */
  readonly rootHumanPrincipalId: HumanPrincipalId;
  /** Trusted, Runtime-derived from the authenticated spawning Run. */
  readonly parentAgentId?: AgentId;
  readonly creatingRunId?: AgentRunId;
}

export type LaunchConfigurationMode =
  | 'inherit-plan' | 'refresh-role' | 'signed-control-replacement';

export interface ResolveLaunchPlanInput {
  readonly agentId: AgentId;
  readonly configurationMode: LaunchConfigurationMode;
  readonly inheritedPlanId?: ResolvedLaunchPlanId;
  readonly replacementPlanId?: ControlReplacementPlanId;
  readonly requestedProvider?: ProviderKind;
  readonly requestedModelId?: string;
  readonly requestedEffort?: string;
  readonly workingDirectory: string;
  /**
   * Whether this launch carries supervised work. A supervised task with a
   * disabled gate or an empty pinned skill list is `LaunchPlanInvalid` here —
   * before an Agent, Run, PTY or provider exists (§6.3).
   */
  readonly supervised: boolean;
}

export interface RecordRelationshipInput {
  readonly rootHumanPrincipalId: HumanPrincipalId;
  readonly parentAgentId: AgentId;
  readonly childAgentId: AgentId;
  readonly createdFromRunId: AgentRunId;
}

export interface IssueDelegationGrantInput {
  readonly issuerAgentRunId: AgentRunId;
  readonly subjectAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
  readonly requestedScopes: readonly AuthorityScope[];
  readonly requestedChildRoleIds: readonly AgentRoleProfileId[];
}

export interface ApplyAgentControlInput {
  readonly agentRunId: AgentRunId;
  readonly agentId: AgentId;
  readonly launchPlanId: ResolvedLaunchPlanId;
  readonly providerSessionId: ProviderSessionId;
  readonly expectedRunVersion: RecordVersion;
  readonly delegationGrantId?: DelegationGrantId;
  readonly control: AgentControl;
}

export type AgentControlOutcome =
  | { readonly kind: 'applied-native'; readonly agentRunId: AgentRunId; readonly control: AgentControl }
  | { readonly kind: 'replacement-required'; readonly plan: ControlReplacementPlan }
  | { readonly kind: 'unsupported'; readonly support: SupportLevel; readonly reason: string };

export interface RegisterProviderSessionInput {
  /** Runtime minted this once and stored it before the Run existed (§5.4). */
  readonly expectedProviderSessionId: ProviderSessionId;
  readonly agentId: AgentId;
  readonly provider: ProviderKind;
  readonly providerConversationId: string | null;
  readonly providerResumeHandle: string | null;
  readonly providerVersion?: string;
  readonly discovery:
    | { readonly state: 'discovered' }
    | { readonly state: 'failed-before-discovery'; readonly reason: string };
}

export interface GetAgentTreeInput {
  readonly rootAgentId: AgentId;
  readonly direction: 'ancestors' | 'descendants' | 'both';
  readonly maxDepth: number;
}

export interface AgentTreeNode {
  readonly agent: Agent;
  readonly relationship?: AgentRelationship;
  readonly depth: number;
}

export interface DiscoverAgentControlsInput {
  readonly agentRunId: AgentRunId;
  readonly launchPlanId: ResolvedLaunchPlanId;
  readonly delegationGrantId?: DelegationGrantId;
}

export interface AgentControlCapability {
  readonly name: AgentControl['name'];
  readonly allowedValues?: readonly string[];
  readonly support: SupportLevel;
  readonly enforcement: EnforcementLevel;
  readonly reason: string;
}

export interface AgentControlCapabilityReport {
  readonly agentRunId: AgentRunId;
  readonly provider: ProviderKind;
  readonly testedProviderVersion: string;
  readonly controls: readonly AgentControlCapability[];
}

/**
 * What the Runtime must know before it may spawn: whose tree this lands in,
 * who the parent is, and which grant permitted it. Derived from the
 * authenticated principal — never from the request (DEC-B3V4-05).
 */
export interface SpawnAuthority {
  readonly rootHumanPrincipalId: HumanPrincipalId;
  readonly parentAgentId?: AgentId;
  readonly grantId?: DelegationGrantId;
  readonly launchSurface: string;
}

export interface AuthoriseSpawnInput {
  readonly roleProfileId: AgentRoleProfileId;
  /** Present when an Agent Run is the caller; absent for human/script callers. */
  readonly callerAgentRunId?: AgentRunId;
  readonly callerAgentId?: AgentId;
}

/** What a continuation may do, according to the plan the old Run was pinned to. */
export interface ContinuationAllowanceInput {
  readonly launchPlanId: ResolvedLaunchPlanId;
  readonly mode: ContinuationMode;
}

// ── The contract ────────────────────────────────────────────────────────────

export interface GovernedAgentsCommands {
  createRoleProfile(
    context: CommandContext, input: CreateRoleProfileInput,
  ): Promise<B3Result<AgentRoleProfile>>;

  updateRoleProfile(
    context: CommandContext, input: UpdateRoleProfileInput,
  ): Promise<B3Result<AgentRoleProfile>>;

  createAgentFromRole(
    context: CommandContext, input: CreateAgentFromRoleInput,
  ): Promise<B3Result<{
    readonly agent: Agent;
    readonly relationship?: AgentRelationship;
  }>>;

  resolveLaunchPlan(
    context: CommandContext, input: ResolveLaunchPlanInput,
  ): Promise<B3Result<ResolvedLaunchPlan>>;

  recordRelationship(
    context: CommandContext, input: RecordRelationshipInput,
  ): Promise<B3Result<AgentRelationship>>;

  issueDelegationGrant(
    context: CommandContext, input: IssueDelegationGrantInput,
  ): Promise<B3Result<DelegationGrant>>;

  applyAgentControl(
    context: CommandContext, input: ApplyAgentControlInput,
  ): Promise<B3Result<AgentControlOutcome>>;

  /** Only the Runtime registers a provider session, and only the id it reserved. */
  registerProviderSession(
    context: SystemCommandContext<'sys_agent_runtime'>, input: RegisterProviderSessionInput,
  ): Promise<B3Result<ProviderSessionView>>;

  /** Revoke every grant a finished Run issued (`expiresWhenIssuerRunFinal`). */
  expireGrantsOfRun(
    context: SystemCommandContext<'sys_agent_runtime'>, agentRunId: AgentRunId,
  ): Promise<B3Result<{ readonly expired: readonly DelegationGrantId[] }>>;
}

export interface GovernedAgentsQueries {
  getAgent(
    principal: AuthenticatedPrincipal, agentId: AgentId,
  ): Promise<B3Result<Agent>>;

  getRoleProfile(
    principal: AuthenticatedPrincipal, roleProfileId: AgentRoleProfileId,
  ): Promise<B3Result<AgentRoleProfile>>;

  /**
   * Every role, so a caller can spawn by NAME. Chris types "builder"; ids are
   * for machines, and a CLI that made him paste a uuidv7 would be a CLI he
   * stops using.
   */
  listRoleProfiles(
    principal: AuthenticatedPrincipal,
  ): Promise<B3Result<readonly AgentRoleProfile[]>>;

  getLaunchPlan(
    principal: AuthenticatedPrincipal, launchPlanId: ResolvedLaunchPlanId,
  ): Promise<B3Result<ResolvedLaunchPlan>>;

  /** Q5's named read of the immutable plan Supervision must verify at install. */
  getResolvedLaunchPlan(
    principal: AuthenticatedPrincipal, launchPlanId: ResolvedLaunchPlanId,
  ): Promise<B3Result<ResolvedLaunchPlan>>;

  getAgentTree(
    principal: AuthenticatedPrincipal, input: GetAgentTreeInput,
  ): Promise<B3Result<B3Page<AgentTreeNode>>>;

  listChildren(
    principal: AuthenticatedPrincipal, parentAgentId: AgentId,
  ): Promise<B3Result<readonly AgentRelationship[]>>;

  /** Every active grant this caller may see, optionally one holder's (§12.1). */
  listDelegationGrants(
    principal: AuthenticatedPrincipal,
    filter?: { readonly holderAgentRunId?: AgentRunId },
  ): Promise<B3Result<readonly DelegationGrant[]>>;

  getProviderSession(
    principal: AuthenticatedPrincipal, providerSessionId: ProviderSessionId,
  ): Promise<B3Result<ProviderSessionView>>;

  discoverAgentControls(
    principal: AuthenticatedPrincipal, input: DiscoverAgentControlsInput,
  ): Promise<B3Result<AgentControlCapabilityReport>>;

  /**
   * The authority question, answered by Agents because Agents owns roles and
   * grants — the Runtime never re-derives it and never widens it (red gate 6).
   */
  authoriseSpawn(
    principal: AuthenticatedPrincipal, input: AuthoriseSpawnInput,
  ): Promise<B3Result<SpawnAuthority>>;

  /**
   * Whether a control operation is permitted on a target Run by this caller.
   * Same intersection rule, so "similar callers use different policy paths"
   * cannot happen (red gate 23).
   */
  authoriseRunOperation(
    principal: AuthenticatedPrincipal,
    input: {
      readonly targetAgentId: AgentId;
      readonly operation: 'interrupt' | 'stop-one' | 'stop-tree' | 'adopt' | 'continue' | 'control';
    },
  ): Promise<B3Result<{ readonly grantId?: DelegationGrantId }>>;

  continuationAllowed(
    principal: AuthenticatedPrincipal, input: ContinuationAllowanceInput,
  ): Promise<B3Result<null>>;

  getControlReplacementPlan(
    principal: AuthenticatedPrincipal, planId: ControlReplacementPlanId,
  ): Promise<B3Result<ControlReplacementPlan>>;
}

export type GovernedAgentsContract = GovernedAgentsCommands & GovernedAgentsQueries;
