/* eslint-disable max-lines -- Supervision's public capability surface remains co-located. */

import type {
  ActivityGeneration,
  AgentId,
  AgentRunId,
  AuthenticatedPrincipal,
  B3ClientOpId,
  B3Page,
  B3PrincipalId,
  B3Result,
  EventCursor,
  IsoUtc,
  RecordEnvelope,
  RecordVersion,
  ResolvedLaunchPlanId,
  ProviderTurnId,
  TerminalInputAttemptId,
  TraceCorrelationId,
  SystemCommandContext,
  CommandContext,
} from '@novakai/foundation/contract';
import type {
  NotificationEvent, PublicEvent, WatchRuleAdmissionEvent,
} from './events.js';
import type {
  DriftEpisodeId,
  NotificationId,
  NotificationInputReservationId,
  WatchDeadlineId,
  WatchEvaluationId,
  WatchRuleId,
} from './identifiers.js';
import type {
  AgentUsageAggregate,
  AgentRunUsage,
  Notification,
  NotificationRecipient,
  WatchDeadline,
  WatchEvaluationProgress,
  WatchEvaluationRuleOutcome,
  WatchEvaluationTrigger,
  WatchRule,
  WatchSubject,
} from './records.js';
import type { VersionedRef } from './policy.js';

/** Public input for WatchRule creation; authoritative envelope fields are omitted. */
export type CreateWatchRuleInput = Omit<
  WatchRule,
  keyof RecordEnvelope<string, string> | 'id' | 'kind' | 'schemaVersion' | 'installation'
>;

/** Spawn-stage input that materialises every watcher pinned by a launch plan. */
export interface InstallRunWatchersInput {
  readonly agentRunId: AgentRunId;
  readonly launchPlanId: ResolvedLaunchPlanId;
  readonly requiredTemplateRefs: readonly VersionedRef[];
  readonly recipient: NotificationRecipient;
  readonly activityGeneration: ActivityGeneration;
  readonly requestProvenance: {
    readonly requestedBy: B3PrincipalId;
    readonly traceId: TraceCorrelationId;
    readonly clientOpId: B3ClientOpId;
  };
}

/** Cross-owner facts re-read from Agents + Runtime before any watcher write. */
export interface ResolvedWatcherInstall {
  readonly agentRunId: AgentRunId;
  readonly launchPlanId: ResolvedLaunchPlanId;
  readonly activityDrift: 'required' | 'disabled-explicitly';
  readonly requiredTemplateRefs: readonly VersionedRef[];
  readonly parentNotificationMode: WatchRule['deliveryMode'];
  readonly recipient: NotificationRecipient;
  readonly activityGeneration: ActivityGeneration;
  /** Scope pinned by Agents when the immutable plan was resolved. */
  readonly watchStartTurnAuthorized: boolean;
  /** Runtime-owned launch attribution, re-read rather than accepted from the install caller. */
  readonly requestProvenance: {
    readonly requestedBy: B3PrincipalId;
    readonly traceId: TraceCorrelationId;
  };
}

/** Host adapter that gives Supervision authoritative Agents/Runtime truth. */
export interface WatcherInstallAuthority {
  resolve(
    principal: AuthenticatedPrincipal,
    input: Pick<InstallRunWatchersInput, 'agentRunId' | 'launchPlanId'>,
  ): Promise<B3Result<ResolvedWatcherInstall>>;
}

/** Host identity adapter used to authorize stable-Agent watcher reads. */
export interface WatchRuleAccess {
  agentIdFor(principal: AuthenticatedPrincipal): Promise<B3Result<AgentId | null>>;
}

/** Agents-owned immutable spawn relationship used by child-derived conditions. */
export interface WatchOccurrenceRelationshipAuthority {
  isDirectManagedChild(
    principal: AuthenticatedPrincipal,
    input: {
      readonly parentAgentId?: AgentId;
      readonly parentAgentRunId?: AgentRunId;
      readonly childAgentId: AgentId;
    },
  ): Promise<B3Result<boolean>>;
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

/** Terminal-observed outcome of one safe-boundary Notification input attempt. */
export type NotificationTurnSubmission =
  | {
      readonly state: 'submitted-confirmed';
      readonly submittedAt: IsoUtc;
      readonly providerTurnId: ProviderTurnId;
    }
  | {
      readonly state: 'submitted-unconfirmed';
      readonly submittedAt: IsoUtc;
      readonly providerTurnId?: ProviderTurnId;
    };

/** Q2's complete Runtime→Supervision CAS command input. */
export interface RecordDriftStatusSubmissionInput {
  readonly watchDeadlineId: WatchDeadlineId;
  readonly expectedRecordVersion: RecordVersion;
  readonly expectedEpisodeId: DriftEpisodeId;
  readonly expectedEffectKey: string;
  readonly expectedNotificationId: NotificationId;
  readonly expectedNotificationInputReservationId: NotificationInputReservationId;
  readonly expectedTerminalInputAttemptId: TerminalInputAttemptId;
  readonly submission: NotificationTurnSubmission;
}

/** Durable authorization resolved from the owning WatchRule or launch plan. */
export interface NotificationDeliveryAuthority {
  readonly notificationId: NotificationId;
  readonly notificationRecordVersion: RecordVersion;
  readonly watchRuleId: WatchRuleId;
  readonly agentRunId: AgentRunId;
  readonly deliveryEffectKey: string;
  readonly activityGeneration: ActivityGeneration;
  readonly deliveryMode: 'start-turn';
  readonly inputText: string;
  readonly semanticSource: 'watcher-status-request' | 'notification-start-turn';
  readonly authoritySource:
    | { readonly kind: 'watch-rule'; readonly watchRuleId: WatchRuleId }
    | { readonly kind: 'launch-plan'; readonly launchPlanId: ResolvedLaunchPlanId };
}

/** CAS claim binding one queued Notification to one Terminal reservation. */
export interface ClaimNotificationDeliveryInput {
  readonly notificationId: NotificationId;
  readonly expectedNotificationRecordVersion: RecordVersion;
  readonly expectedEffectKey: string;
  readonly notificationInputReservationId: NotificationInputReservationId;
  readonly expectedActivityGeneration: ActivityGeneration;
}

/** The records Supervision alone may advance during a successful claim. */
export interface NotificationDeliveryClaim {
  readonly notification: Notification;
  readonly watchDeadline?: WatchDeadline;
}

/** Runtime's complete owner-reconciled outcome for a non-drift Notification. */
export interface RecordNotificationDeliveryOutcomeInput {
  readonly notificationId: NotificationId;
  readonly expectedRecordVersion: RecordVersion;
  readonly expectedEffectKey: string;
  readonly notificationInputReservationId: NotificationInputReservationId;
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly outcome: NotificationTurnSubmission;
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

/** §12.7's per-Agent usage view; its aggregate is not itself a Run. */
export interface AgentUsageSummary {
  readonly agentId: AgentId;
  readonly runs: readonly AgentRunUsage[];
  readonly aggregate: AgentUsageAggregate;
}

/** Durable notification query filter. */
export interface NotificationFilter {
  readonly recipient?: NotificationRecipient;
  readonly state?: readonly Notification['state'][];
  readonly cursor?: EventCursor;
  readonly limit: number;
}

/**
 * Durable WatchRule keyset page. `cursor` is an opaque `watchRules.*` position
 * over stable `(createdAt,id)` order, applied before the current filter and
 * visibility policy; changing either does not invalidate it. `omissions`
 * counts matching rows hidden across the remaining continuation.
 * This is a live continuation, not a historical snapshot.
 */
export interface WatchRuleFilter {
  readonly subject?: WatchSubject;
  readonly status?: readonly WatchRule['status'][];
  readonly cursor?: EventCursor;
  readonly limit: number;
}

/** Bounded operator scan over durable, append-only watcher progress. */
export interface WatchEvaluationProgressFilter {
  readonly watchRuleId?: WatchRuleId;
  readonly triggerKind?: WatchEvaluationTrigger['kind'];
  readonly state?: WatchEvaluationProgress['state'];
  readonly outcomeKind?: WatchEvaluationRuleOutcome['kind'];
  readonly cursor?: EventCursor;
  readonly limit: number;
}

/** Existing v1 bounded-page method reused by the amended Q8 wire mapping. */
export const SUPERVISION_NOTIFICATION_SUBSCRIBE_METHOD =
  'b3.supervision.subscribeNotifications' as const;

/** Existing generic `EventFrame.name` for unsolicited Notification pushes. */
export const SUPERVISION_NOTIFICATION_PUSH_EVENT =
  'b3.supervision.notification.changed' as const;

/** Cursor-resumable, bounded request input; stopping requests is cancellation. */
export interface NotificationEventPageInput {
  readonly after?: EventCursor;
  readonly limit: number;
}

/** The page payload carried by the existing request/response frame. */
export type NotificationEventPage = B3Page<NotificationEvent>;

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
  recordDriftStatusSubmission(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: RecordDriftStatusSubmissionInput,
  ): Promise<B3Result<WatchDeadline>>;
  claimNotificationDelivery(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: ClaimNotificationDeliveryInput,
  ): Promise<B3Result<NotificationDeliveryClaim>>;
  recordNotificationDeliveryOutcome(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: RecordNotificationDeliveryOutcomeInput,
  ): Promise<B3Result<Notification>>;
}

/** Frozen B3d Supervision read/stream surface (§12.4). */
export interface SupervisionQueries {
  subscribeWatchRuleAdmissionSignals(
    principal: AuthenticatedPrincipal,
    after?: EventCursor,
  ): AsyncIterable<B3Result<WatchRuleAdmissionEvent>>;
  getWatchEvaluationProgress(
    principal: AuthenticatedPrincipal,
    watchEvaluationId: WatchEvaluationId,
  ): Promise<B3Result<WatchEvaluationProgress | null>>;
  listWatchEvaluationProgress(
    principal: AuthenticatedPrincipal,
    filter: WatchEvaluationProgressFilter,
  ): Promise<B3Result<B3Page<WatchEvaluationProgress>>>;
  getNotificationDeliveryAuthority(
    principal: AuthenticatedPrincipal,
    notificationId: NotificationId,
  ): Promise<B3Result<NotificationDeliveryAuthority>>;
  getRunUsage(
    principal: AuthenticatedPrincipal,
    agentRunId: AgentRunId,
  ): Promise<B3Result<AgentRunUsage>>;
  getAgentUsage(
    principal: AuthenticatedPrincipal,
    agentId: AgentId,
  ): Promise<B3Result<AgentUsageSummary>>;
  listWatchRules(
    principal: AuthenticatedPrincipal,
    filter: WatchRuleFilter,
  ): Promise<B3Result<B3Page<WatchRule>>>;
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
