import type {
  ActivityGeneration,
  AgentId,
  AgentRunId,
  AuthenticatedPrincipal,
  B3Page,
  B3Result,
  EventCursor,
  IsoUtc,
  RecordEnvelope,
  RecordVersion,
  ResolvedLaunchPlanId,
  SystemCommandContext,
  CommandContext,
} from '@novakai/foundation/contract';
import type { NotificationEvent, PublicEvent } from './events.js';
import type { DriftEpisodeId, NotificationId, WatchDeadlineId, WatchRuleId } from './identifiers.js';
import type {
  AgentRunUsage,
  Notification,
  NotificationRecipient,
  WatchDeadline,
  WatchRule,
} from './records.js';

/** Public input for WatchRule creation; authoritative envelope fields are omitted. */
export type CreateWatchRuleInput = Omit<
  WatchRule,
  keyof RecordEnvelope<string, string> | 'id' | 'kind' | 'schemaVersion'
>;

/** Immutable reference to one pinned role watcher template. */
export interface VersionedRef {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

/** Spawn-stage input that materialises every watcher pinned by a launch plan. */
export interface InstallRunWatchersInput {
  readonly agentRunId: AgentRunId;
  readonly launchPlanId: ResolvedLaunchPlanId;
  readonly requiredTemplateRefs: readonly VersionedRef[];
}

/** Exact-CAS replacement of a WatchRule. */
export interface UpdateWatchRuleInput {
  readonly watchRuleId: WatchRuleId;
  readonly expectedRecordVersion: RecordVersion;
  readonly replacement: CreateWatchRuleInput;
}

/** At-least-once committed event offered to the watcher reducer. */
export interface EvaluateSupervisionEventInput {
  readonly event: PublicEvent<string, Readonly<Record<string, unknown>>>;
}

/** Bounded scheduler claim query. */
export interface ClaimDueDeadlinesInput {
  readonly dueBefore: IsoUtc;
  readonly limit: number;
  readonly schedulerLeaseMs: number;
}

/** Exact generation/version fence for one drift evaluation. */
export interface CheckRunDriftInput {
  readonly watchRuleId: WatchRuleId;
  readonly agentRunId: AgentRunId;
  readonly expectedActivityGeneration: ActivityGeneration;
  readonly dueDeadlineId: WatchDeadlineId;
  readonly expectedDeadlineRecordVersion: RecordVersion;
}

/** Human reset fenced to the exact durable drift episode. */
export interface ResetDriftEpisodeInput {
  readonly watchDeadlineId: WatchDeadlineId;
  readonly expectedRecordVersion: RecordVersion;
  readonly expectedEpisodeId: DriftEpisodeId;
  readonly reason: string;
}

/** Exact observable outcomes from §12.7; every evaluation starts zero turns. */
export type DriftCheckOutcome =
  | {
      readonly kind: 'healthy-free-evidence';
      readonly providerTurnsStartedThisEvaluation: 0;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly kind: 'first-quiet-interval';
      readonly providerTurnsStartedThisEvaluation: 0;
      readonly staleIntervals: 1;
    }
  | {
      readonly kind: 'status-turn-queued';
      readonly providerTurnsStartedThisEvaluation: 0;
      readonly staleIntervals: 2;
      readonly notificationId: NotificationId;
      readonly effectKey: string;
    }
  | {
      readonly kind: 'status-replied';
      readonly providerTurnsStartedThisEvaluation: 0;
      readonly consecutiveDrift: 0;
      readonly replyEvidenceRef: string;
    }
  | {
      readonly kind: 'status-cancelled-before-delivery';
      readonly providerTurnsStartedThisEvaluation: 0;
      readonly episodeId: DriftEpisodeId;
      readonly movementEvidenceRef: string;
    }
  | {
      readonly kind: 'status-still-unanswered';
      readonly providerTurnsStartedThisEvaluation: 0;
      readonly consecutiveUnansweredChecks: 1 | 2;
      readonly effectKey: string;
    }
  | {
      readonly kind: 'human-escalation-queued';
      readonly providerTurnsStartedThisEvaluation: 0;
      readonly consecutiveUnansweredChecks: 3;
      readonly notificationId: NotificationId;
      readonly state: 'escalated-waiting-human';
    };

/** §12.7's per-Agent usage view; aggregate Run identity is spec-ambiguous. */
export interface AgentUsageSummary {
  readonly agentId: AgentId;
  readonly runs: readonly AgentRunUsage[];
  readonly aggregate: AgentRunUsage;
}

/** Durable notification query filter. */
export interface NotificationFilter {
  readonly recipient?: NotificationRecipient;
  readonly state?: readonly Notification['state'][];
  readonly cursor?: EventCursor;
  readonly limit: number;
}

/** Frozen B3d Supervision mutation surface (§12.4). */
export interface SupervisionCommands {
  installRunWatchers(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: InstallRunWatchersInput,
  ): Promise<B3Result<readonly WatchRule[]>>;
  createWatchRule(
    context: CommandContext,
    input: CreateWatchRuleInput,
  ): Promise<B3Result<WatchRule>>;
  updateWatchRule(
    context: CommandContext,
    input: UpdateWatchRuleInput,
  ): Promise<B3Result<WatchRule>>;
  evaluateEvent(
    context: SystemCommandContext<
      'sys_agents' | 'sys_agent_runtime' | 'sys_transcript' | 'sys_messaging'
    >,
    input: EvaluateSupervisionEventInput,
  ): Promise<B3Result<readonly Notification[]>>;
  claimDueDeadlines(
    context: SystemCommandContext<'sys_supervision'>,
    input: ClaimDueDeadlinesInput,
  ): Promise<B3Result<readonly WatchDeadline[]>>;
  checkRunDrift(
    context: SystemCommandContext<'sys_supervision'>,
    input: CheckRunDriftInput,
  ): Promise<B3Result<DriftCheckOutcome>>;
  acknowledgeNotification(
    context: CommandContext,
    notificationId: NotificationId,
  ): Promise<B3Result<Notification>>;
  resetDriftEpisode(
    context: CommandContext,
    input: ResetDriftEpisodeInput,
  ): Promise<B3Result<WatchDeadline>>;
}

/** Frozen B3d Supervision read/stream surface (§12.4). */
export interface SupervisionQueries {
  getRunUsage(
    principal: AuthenticatedPrincipal,
    agentRunId: AgentRunId,
  ): Promise<B3Result<AgentRunUsage>>;
  getAgentUsage(
    principal: AuthenticatedPrincipal,
    agentId: AgentId,
  ): Promise<B3Result<AgentUsageSummary>>;
  listNotifications(
    principal: AuthenticatedPrincipal,
    filter: NotificationFilter,
  ): Promise<B3Result<B3Page<Notification>>>;
  subscribeNotifications(
    principal: AuthenticatedPrincipal,
    after?: EventCursor,
  ): AsyncIterable<B3Result<NotificationEvent>>;
}

/** One composition surface for embedded Supervision hosts. */
export type SupervisionContract = SupervisionCommands & SupervisionQueries;
