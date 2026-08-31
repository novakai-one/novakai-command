// Agents' governed-team records.
//
// Agents already owned "who an Agent is". The governed tree adds the four
// facts that make a team governable rather than merely present: the reusable
// ROLE, the immutable PLAN a Run was actually launched with, the immutable
// FAMILY edge, and the run-scoped GRANT that decides what an Agent may do to
// another Agent.
//
// Agents is the sole writer of all of them. Nothing here opens a file:
// durability is Foundation's one engine, through one scoped handle.
import type {
  AgentId, AgentRelationshipId, AgentRoleProfileId, AgentRunId, AuthorityScope,
  ControlReplacementPlanId, DelegationGrantId, HumanPrincipalId, IsoUtc,
  ProviderSessionId, RecordEnvelope, ResolvedLaunchPlanId,
} from '@novakai/foundation/contract';

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const PROVIDER_KINDS = ['claude', 'codex', 'kimi'] as const;
export type ProviderKind = typeof PROVIDER_KINDS[number];

export const LAUNCH_SURFACES = [
  'novakai-shell', 'external-terminal', 'agent', 'script', 'operations',
] as const;
export type LaunchSurface = typeof LAUNCH_SURFACES[number];

/**
 * How true a claimed capability is. `advisory` and `unavailable` exist so a
 * provider that cannot do something is never described as one that can.
 */
export const SUPPORT_LEVELS = [
  'native', 'replacement-required', 'advisory', 'unsupported', 'unavailable',
] as const;
export type SupportLevel = typeof SUPPORT_LEVELS[number];

export const ENFORCEMENT_LEVELS = ['enforced', 'advisory', 'unavailable'] as const;
export type EnforcementLevel = typeof ENFORCEMENT_LEVELS[number];

/** A pinned reference: which thing, which version, and proof of its content. */
export interface VersionedRef {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

/** Authority-relevant facts Agents owns beside each exact watcher ref. */
export interface WatcherTemplateRefFacts {
  readonly requiresStartTurn: boolean;
}

/** Agents-owned role-profile catalogue query used to validate watcher refs. */
export interface WatcherTemplateRefCatalogue {
  inspect(templateRef: VersionedRef): WatcherTemplateRefFacts | null;
  /** The exact ref for the one implicit watcher template, from the same catalogue. */
  activityDriftRef(): VersionedRef | null;
}

// ── The governed role ───────────────────────────────────────────────────────

export interface ProviderPolicy {
  readonly allowed: readonly ProviderKind[];
  readonly defaultProvider: ProviderKind;
}

export interface ModelPolicy {
  readonly allowedModelIds: readonly string[];
  readonly defaultModelId: string;
  readonly allowNativeChange: boolean;
  readonly allowReplacementChange: boolean;
}

export interface EffortPolicy {
  readonly allowed: readonly string[];
  readonly defaultEffort: string;
}

export interface SpawnPolicy {
  readonly allowedChildRoleIds: readonly AgentRoleProfileId[];
  readonly maxDepth?: number;
  readonly maxLiveChildren?: number;
  readonly requireManagedSpawn: boolean;
}

/**
 * The two-turn skills-confirmation gate. `disabled` is legal for exactly one
 * case — an interactive chat launch with no supervised task — and the
 * launch-plan resolver refuses every other combination BEFORE any effect.
 */
export type SkillsConfirmationGate =
  | { readonly mode: 'disabled'; readonly allowedFor: 'interactive-chat-only' }
  | {
      readonly mode: 'required-two-turn';
      readonly confirmationMarker: 'SKILLS-CONFIRMED:';
      readonly confirmationTokenFormat: 'skill-id@v<version>#<digest>';
      readonly comparison: 'exact-set-canonical-order';
      readonly subagentEvidenceMarker: 'SUBAGENT-SKILLS:';
      readonly providerNativeSubagentPolicy:
        | 'managed-only-for-supervised-work' | 'observe-advisory';
      readonly onFailure: 'terminate-run-and-record-drift';
    };

export const CONTINUATION_MODES = ['resume', 'fresh', 'compact', 'handover'] as const;
export type ContinuationMode = typeof CONTINUATION_MODES[number];

export interface LifecyclePolicy {
  readonly onTaskComplete: 'keep-running' | 'stop-run' | 'request-decision';
  readonly onSupervisorFinal:
    | 'assign-human' | 'assign-nearest-live-ancestor' | 'remain-orphaned';
  readonly allowedContinuationModes: readonly ContinuationMode[];
}

export interface RoleSupervisionPolicy {
  /** The one implicit watcher; every other watcher remains an explicit ref. */
  readonly activityDrift: 'required' | 'disabled-explicitly';
  readonly requiredWatcherTemplates: readonly VersionedRef[];
  readonly parentNotificationMode: 'queue-only' | 'next-turn-context' | 'start-turn';
}

export interface ResolvedSupervisionPolicy extends RoleSupervisionPolicy {
  /** Required exactly when activityDrift is required. */
  readonly activityDriftTemplateRef?: VersionedRef;
}

export interface BudgetPolicy {
  readonly inputTokenSoftLimit?: number;
  readonly outputTokenSoftLimit?: number;
  readonly costSoftLimitMicros?: number;
  readonly turnSoftLimit?: number;
  readonly hardStopEnabled: boolean;
}

/**
 * Manager, builder, auditor — data, not three CLI programs. Updating a role
 * creates a new `recordVersion`; it never reaches into a Run's already-pinned
 * plan.
 */
export interface AgentRoleProfile
  extends RecordEnvelope<AgentRoleProfileId, 'agentRoleProfile'> {
  readonly name: string;
  readonly description: string;
  readonly status: 'active' | 'retired';
  readonly providerPolicy: ProviderPolicy;
  readonly modelPolicy: ModelPolicy;
  readonly effortPolicy: EffortPolicy;
  readonly skillRefs: readonly VersionedRef[];
  readonly hookRefs: readonly VersionedRef[];
  readonly instructionRefs: readonly VersionedRef[];
  readonly skillsConfirmationGate: SkillsConfirmationGate;
  readonly executionPolicyRef: VersionedRef;
  readonly spawnPolicy: SpawnPolicy;
  readonly lifecyclePolicy: LifecyclePolicy;
  readonly supervisionPolicy: RoleSupervisionPolicy;
  readonly budgetPolicy: BudgetPolicy;
}

// ── Agent, plan, family, grant ──────────────────────────────────────────────

/**
 * The stable individual. Its Runs come and go; it does not.
 *
 * Persistence note: this is the governed VIEW of Foundation kind `agent`. The
 * stored line additionally carries the legacy `provider`/`model`/
 * `instructions`/`hooks`/`skills` fields so the existing Agents registry keeps
 * reading the same record — one agent store, one writer, two readers.
 */
export interface Agent extends RecordEnvelope<AgentId, 'agent'> {
  readonly displayName: string;
  readonly roleProfileId: AgentRoleProfileId;
  readonly rootHumanPrincipalId: HumanPrincipalId;
  readonly status: 'active' | 'archived';
  readonly origin: 'nvk-spawned' | 'provider-spawned' | 'agent-spawned';
  readonly sessionId?: string;
  readonly sessions: readonly string[];
}

export interface ResolvedExecutionPolicy {
  readonly policyRef: VersionedRef;
  readonly commandScopes: readonly string[];
  readonly filesystemScopes: readonly string[];
  readonly networkScopes: readonly string[];
  /**
   * Honest, not aspirational. Novakai's own scopes are `enforced`; OS/provider
   * command restriction stays `advisory` or `unavailable` until a sandbox
   * adapter exists.
   */
  readonly enforcement: EnforcementLevel;
  readonly limitations: readonly string[];
}

/**
 * What a Run was ACTUALLY launched with, frozen at resolution time. Editing a
 * role afterwards cannot weaken a live Agent, because the Run points here and
 * this record never changes.
 */
export interface ResolvedLaunchPlan
  extends RecordEnvelope<ResolvedLaunchPlanId, 'resolvedLaunchPlan'> {
  readonly agentId: AgentId;
  readonly roleProfile: VersionedRef;
  readonly provider: ProviderKind;
  readonly modelId: string;
  readonly effort: string;
  readonly workingDirectory: string;
  readonly skills: readonly VersionedRef[];
  readonly hooks: readonly VersionedRef[];
  readonly instructions: readonly VersionedRef[];
  readonly skillsConfirmationGate: SkillsConfirmationGate;
  readonly executionPolicy: ResolvedExecutionPolicy;
  readonly spawnPolicy: SpawnPolicy;
  readonly lifecyclePolicy: LifecyclePolicy;
  readonly supervisionPolicy: ResolvedSupervisionPolicy;
  readonly budgetPolicy: BudgetPolicy;
  /** Proof that two callers resolving the same inputs got the same plan. */
  readonly resolutionFingerprint: string;
}

/**
 * Who spawned whom — append-only, forever. Adoption moves the supervision
 * assignment and never touches this edge.
 */
export interface AgentRelationship
  extends RecordEnvelope<AgentRelationshipId, 'agentRelationship'> {
  readonly rootHumanPrincipalId: HumanPrincipalId;
  readonly parentAgentId: AgentId;
  readonly childAgentId: AgentId;
  readonly createdFromRunId: AgentRunId;
}

/**
 * Run-scoped authority: the intersection of root policy, role policy and what
 * the issuer actually had. It cannot be widened by its holder, and it dies
 * with the issuing Run.
 */
export interface DelegationGrant
  extends RecordEnvelope<DelegationGrantId, 'delegationGrant'> {
  readonly issuerAgentRunId: AgentRunId;
  readonly subjectAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
  readonly scopes: readonly AuthorityScope[];
  readonly allowedChildRoleIds: readonly AgentRoleProfileId[];
  readonly expiresWhenIssuerRunFinal: true;
  readonly status: 'active' | 'revoked' | 'expired';
}

/** What a control CANNOT do live: it proposes a replacement Run, never applies one. */
export interface ControlReplacementPlan
  extends RecordEnvelope<ControlReplacementPlanId, 'controlReplacementPlan'> {
  readonly agentId: AgentId;
  readonly expectedOldRunId: AgentRunId;
  readonly requestedControl: AgentControl;
  readonly proposedLaunchPlanId: ResolvedLaunchPlanId;
  readonly expiresAt: IsoUtc;
  readonly signedDigest: string;
}

export const AGENT_CONTROL_NAMES = ['model', 'effort', 'provider-setting'] as const;
export type AgentControlName = typeof AGENT_CONTROL_NAMES[number];

export interface AgentControl {
  readonly name: AgentControlName;
  readonly value: string;
}

// ── The provider session, as the governed tree sees it ──────────────────────

/**
 * The resumable provider handle, and nothing else. Lifecycle moved to
 * `AgentRun`, working directory and model to `ResolvedLaunchPlan`, usage to
 * evidence records — this record stopped being four authorities wearing one
 * name.
 *
 * Stored under its OWN kind, `providerSessionHandle`. Writing this shape under
 * kind `providerSession` once put a cwd-less record in front of the older
 * session registry and killed every usage tick until it was caught. One kind,
 * one writer, one shape. Legacy v1 records are still READ from
 * `providerSession` (normaliseToGovernedView), never written.
 */
export interface ProviderSessionView
  extends RecordEnvelope<ProviderSessionId, 'providerSessionHandle'> {
  readonly agentId: AgentId;
  readonly provider: ProviderKind;
  readonly providerConversationId: string | null;
  readonly providerResumeHandle: string | null;
  readonly providerVersion?: string;
  readonly discovery:
    | { readonly state: 'discovered' }
    | { readonly state: 'failed-before-discovery'; readonly reason: string };
}
