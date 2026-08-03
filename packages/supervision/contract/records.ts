import type {
  ActivityGeneration,
  AgentId,
  AgentRunId,
  B3ErrorCode,
  B3ClientOpId,
  B3PrincipalId,
  CommandReceiptId,
  IsoUtc,
  ProviderSessionId,
  ProviderTurnId,
  RecordEnvelope,
  RecordVersion,
  ResolvedLaunchPlanId,
  RuntimeEpochId,
  RunOperationId,
  TerminalInputAttemptId,
  TraceCorrelationId,
  TranscriptTurnCompletionId,
} from '@novakai/foundation/contract';
import type { HumanPrincipalId } from './shared.js';
import type { DurableDriftState } from './drift.js';
import type {
  DriftEpisodeId,
  NotificationId,
  ProviderUsageEvidenceId,
  NotificationInputReservationId,
  NotificationDeliveryFenceOperationId,
  WatchEvaluationId,
  WatchDeadlineId,
  WatchRuleId,
} from './identifiers.js';

/** Provenance quality for one usage value (§9.1). */
export type MeasurementQuality = 'measured' | 'estimated' | 'partial' | 'unavailable';

/** One sourced usage fact; absent evidence is never represented as zero. */
export interface UsageValue {
  readonly quality: MeasurementQuality;
  readonly value?: number;
  readonly source: string;
  readonly limitations: readonly string[];
}

/** Rebuildable per-Run usage truth; this is never a stored aggregate. */
export interface AgentRunUsage {
  readonly agentRunId: AgentRunId;
  readonly inputTokens: UsageValue;
  readonly outputTokens: UsageValue;
  readonly cachedInputTokens: UsageValue;
  readonly costMicros: UsageValue;
  readonly providerTurns: UsageValue;
  readonly observedAt: IsoUtc;
  readonly final: boolean;
}

export type AgentRunLifecycle =
  | 'provisioning' | 'ready' | 'interrupted' | 'continuation-pending'
  | 'stopping' | 'stopped' | 'failed' | 'recovery-required';

export type AgentRunActivity =
  | 'idle' | 'working' | 'waiting-provider' | 'waiting-input' | 'interrupting' | 'unknown';

/** Complete Runtime correlation view, including final history. */
export interface RunUsageFacts {
  readonly agentRunId: AgentRunId;
  readonly agentId: AgentId;
  readonly providerSessionId: ProviderSessionId;
  readonly lifecycle: AgentRunLifecycle;
  readonly final: boolean;
  readonly activityGeneration: ActivityGeneration;
  readonly recordVersion: RecordVersion;
}

/** Aggregate projection over the `runs` returned beside it; never a synthetic Run. */
export type AgentUsageAggregate = Omit<AgentRunUsage, 'agentRunId'>;

/** Provider-native totals retained by the Agents authority (§5.5). */
export interface ProviderUsageMeasurement {
  readonly quality: MeasurementQuality;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costMicros?: number;
  readonly providerTurns?: number;
  readonly limitations: readonly string[];
  readonly evidenceDigest: string;
}

/** Append-only authoritative usage evidence consumed by Supervision. */
export interface ProviderUsageEvidence extends RecordEnvelope<
  ProviderUsageEvidenceId,
  'providerUsageEvidence'
> {
  readonly providerSessionId: ProviderSessionId;
  readonly providerConversationId: string | null;
  /** Omitted on pre-amendment rows and therefore interpreted as cumulative. */
  readonly scope?:
    | { readonly kind: 'provider-session-cumulative' }
    | {
        readonly kind: 'runtime-turn-completion';
        readonly agentRunId: AgentRunId;
        readonly providerTurnId: ProviderTurnId;
        readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
      };
  readonly observedAt: IsoUtc;
  readonly source: string;
  readonly sourceCursor?: string;
  readonly measurement: ProviderUsageMeasurement;
}

/** A condition evaluated without creating a watcher-owned model turn. */
export type WatchCondition =
  | { readonly kind: 'turn-count-at-least'; readonly value: number }
  | { readonly kind: 'input-tokens-at-least'; readonly value: number }
  | { readonly kind: 'output-tokens-at-least'; readonly value: number }
  | { readonly kind: 'cost-micros-at-least'; readonly value: number }
  | { readonly kind: 'idle-for-ms'; readonly value: number }
  | {
      readonly kind: 'activity-drift';
      readonly intervalMs: number;
      readonly staleAfterIntervals: 2;
      readonly escalateAfterConsecutive: 3;
    }
  | { readonly kind: 'run-disconnected' }
  | { readonly kind: 'run-final' }
  | { readonly kind: 'child-needs-help' }
  | { readonly kind: 'operation-failed' };

/** Runtime-owned facts used by the exact Q6 `run-disconnected` edge mapping. */
export interface RunConnectionSnapshot {
  readonly activity: AgentRunActivity;
  /** Sorted, duplicate-free Runtime uncertainty-code snapshot. */
  readonly uncertaintyCodes: readonly string[];
  readonly activityGeneration: ActivityGeneration;
  readonly observedAt: IsoUtc;
}

/** True only for a new non-final provider-session reachability-loss generation. */
export function isRunDisconnectedEdge(
  previous: RunConnectionSnapshot,
  current: RunConnectionSnapshot,
): boolean {
  const code = 'provider-liveness-unknown';
  return !previous.uncertaintyCodes.includes(code)
    && current.uncertaintyCodes.includes(code)
    && current.activity === 'unknown'
    && Number(current.activityGeneration) > Number(previous.activityGeneration);
}

export interface RunOccurrenceEventBase {
  readonly eventId: string;
  readonly occurredAt: IsoUtc;
  readonly committedAt: IsoUtc;
  readonly sourceOwner: 'agent-runtime';
  readonly agentRunId: AgentRunId;
  readonly agentId: AgentId;
  readonly providerSessionId: ProviderSessionId;
  readonly lifecycle: AgentRunLifecycle;
  readonly final: boolean;
  readonly activityGeneration: ActivityGeneration;
  readonly canonicalPayloadDigest: string;
}

export type RunOccurrenceEventFacts = RunOccurrenceEventBase & (
  | {
      readonly kind: 'agent.run.usage.changed';
      readonly occurrenceKind: 'usage-generation';
      readonly occurrence: { readonly qualifyingEvidenceRef: ProviderUsageEvidenceId };
    }
  | {
      readonly kind: 'agent.run.lifecycle.changed';
      readonly occurrenceKind: 'run-final';
      readonly occurrence:
        | { readonly toLifecycle: 'stopped' | 'failed'; readonly reconciledFinal?: never }
        | { readonly toLifecycle: 'interrupted'; readonly reconciledFinal: true };
    }
  | {
      readonly kind: 'agent.run.activity.changed';
      readonly occurrenceKind: 'run-disconnected';
      readonly occurrence: {
        readonly previous: RunConnectionSnapshot;
        readonly current: RunConnectionSnapshot;
      };
    }
  | {
      readonly kind: 'runtime.recovery.required';
      readonly occurrenceKind: 'child-needs-help';
      readonly occurrence: {
        readonly recoveryReason: string;
        readonly evidenceRefs: readonly string[];
      };
    }
  | {
      readonly kind: 'agent.run.operation.stage.changed';
      readonly occurrenceKind: 'operation-failed';
      readonly occurrence: {
        readonly runOperationId: RunOperationId;
        readonly terminalState: 'failed' | 'recovery-required';
        readonly reason: string;
      };
    }
);

/** Stable watcher target. */
export type WatchSubject =
  | { readonly kind: 'agent'; readonly agentId: AgentId }
  | { readonly kind: 'agent-run'; readonly agentRunId: AgentRunId }
  | { readonly kind: 'children-of'; readonly agentId: AgentId };

/** Stable recipient; replacement Runs do not change this identity. */
export type NotificationRecipient =
  | { readonly kind: 'agent'; readonly agentId: AgentId }
  | { readonly kind: 'human'; readonly principalId: HumanPrincipalId };

/** Exact cheap-first policy attached only to activity-drift rules. */
export interface DriftCheckPolicy {
  readonly mode: 'cheap-first';
  readonly freeEvidence: readonly [
    'terminal-liveness',
    'transcript-advance',
    'usage-delta',
  ];
  readonly statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious';
  readonly statusRecipient: 'subject-agent';
  readonly statusDeliveryMode: 'start-turn';
  readonly replyWindowMs: number;
  readonly statusPrompt: 'Status check: reply with one line — what are you working on right now?';
}

/** Schema reservation for Operations; never executable in Build 3. */
export interface FutureOperationAction {
  readonly operationDefinitionId: string;
  readonly contractVersion: 1;
  readonly status: 'reserved-not-executable-in-build3';
}

/** Authoritative watcher rule. */
export interface WatchRule extends RecordEnvelope<WatchRuleId, 'watchRule'> {
  readonly subject: WatchSubject;
  readonly condition: WatchCondition;
  readonly recipient: NotificationRecipient;
  readonly deliveryMode: 'queue-only' | 'next-turn-context' | 'start-turn';
  readonly cooldownMs: number;
  readonly status: 'active' | 'paused' | 'retired';
  readonly driftPolicy?: DriftCheckPolicy;
  readonly action?: FutureOperationAction;
  /** Immutable cause of an automatically installed role watcher (Q10). */
  readonly installation?: {
    readonly launchPlanId: ResolvedLaunchPlanId;
    readonly templateRef: { readonly id: string; readonly version: number; readonly digest: string };
    readonly activityGeneration: ActivityGeneration;
    readonly requestedBy: B3PrincipalId;
    readonly requestTraceId: TraceCorrelationId;
    readonly requestClientOpId: B3ClientOpId;
  };
}

/** Durable generation-fenced deadline and optional drift episode state. */
export interface WatchDeadline extends RecordEnvelope<WatchDeadlineId, 'watchDeadline'> {
  readonly watchRuleId: WatchRuleId;
  readonly subjectKey: string;
  readonly activityGeneration: ActivityGeneration;
  readonly dueAt: IsoUtc;
  readonly state: 'armed' | 'claimed' | 'fired' | 'superseded';
  readonly claimedByRuntimeEpochId?: RuntimeEpochId;
  readonly lateByMs?: number;
  readonly driftState?: DurableDriftState;
  /** Required on every post-activation ordinary non-drift deadline. */
  readonly creationRecordVersion?: RecordVersion;
  /** Required and non-negative on every post-activation ordinary non-drift deadline. */
  readonly armingOrdinal?: number;
}

/** Durable Notification lifecycle states. */
export type NotificationState =
  | 'queued' | 'offered-to-endpoint' | 'transcript-observed'
  | 'acknowledged' | 'delivery-uncertain' | 'expired';

const NOTIFICATION_TRANSITIONS: Readonly<Record<NotificationState, readonly NotificationState[]>> = {
  queued: ['offered-to-endpoint', 'delivery-uncertain', 'expired'],
  'offered-to-endpoint': ['transcript-observed', 'delivery-uncertain', 'expired'],
  'delivery-uncertain': ['transcript-observed', 'expired'],
  'transcript-observed': ['acknowledged', 'expired'],
  acknowledged: [],
  expired: [],
};

/** One authority for legal Notification lifecycle movement. */
export function canTransitionNotificationState(
  from: NotificationState,
  target: NotificationState,
): boolean {
  return NOTIFICATION_TRANSITIONS[from].includes(target);
}

/** Durable Q7 delivery-attempt truth, persisted before and after provider effects. */
export type NotificationDeliveryAttempt =
  | { readonly state: 'queued'; readonly effectKey: string }
  | {
      readonly state: 'delivery-claimed';
      readonly effectKey: string;
      readonly claimedAt: IsoUtc;
      readonly notificationInputReservationId: NotificationInputReservationId;
    }
  | {
      readonly state: 'submitted-confirmed';
      readonly effectKey: string;
      readonly submittedAt: IsoUtc;
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly providerTurnId: ProviderTurnId;
    }
  | {
      readonly state: 'submitted-unconfirmed';
      readonly effectKey: string;
      readonly submittedAt: IsoUtc;
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly providerTurnId?: ProviderTurnId;
    };

/** Notification fields shared by condition and drift phases. */
export interface NotificationBase extends RecordEnvelope<NotificationId, 'notification'> {
  readonly deliveryEffectKey: string;
  readonly deliveryAttempt: NotificationDeliveryAttempt;
  readonly watchRuleId: WatchRuleId;
  readonly subject: WatchSubject;
  readonly recipient: NotificationRecipient;
  readonly conditionGeneration: number;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly state: NotificationState;
  readonly deliveryMode: WatchRule['deliveryMode'];
}

/** Authoritative occurrence provenance constructed by Supervision. */
export type ConditionOccurrence =
  | {
      readonly kind: 'agent-run';
      readonly agentRunId: AgentRunId;
      readonly providerSessionId: ProviderSessionId;
      readonly qualifyingEvidenceRef: ProviderUsageEvidenceId;
      readonly qualifiedAt: IsoUtc;
    }
  | {
      readonly kind: 'run-final';
      readonly agentRunId: AgentRunId;
      readonly providerSessionId: ProviderSessionId;
      readonly qualifyingEvidenceRef: string;
      readonly qualifiedAt: IsoUtc;
    }
  | {
      readonly kind: 'committed-event';
      readonly eventId: string;
      readonly agentRunId: AgentRunId;
      readonly providerSessionId: ProviderSessionId;
      readonly qualifyingEvidenceRef: string;
      readonly qualifiedAt: IsoUtc;
    }
  | {
      readonly kind: 'run-operation';
      readonly runOperationId: RunOperationId;
      readonly agentRunId: AgentRunId;
      readonly providerSessionId: ProviderSessionId;
      readonly qualifyingEvidenceRef: string;
      readonly qualifiedAt: IsoUtc;
    };

/** Per-target-Run delivery baseline; generations never compare across Runs. */
export interface NotificationDeliveryFence {
  readonly targetAgentRunId: AgentRunId;
  readonly baselineActivityGeneration: ActivityGeneration;
  readonly boundAt: IsoUtc;
}

export type NotificationV2Base = Omit<
  NotificationBase,
  keyof RecordEnvelope<NotificationId, 'notification', 1>
> & RecordEnvelope<NotificationId, 'notification', 2>;

/** Durable notification with exact legacy-v1 and occurrence-aware-v2 branches. */
export type Notification =
  | (NotificationBase & (
      | { readonly phase: 'condition'; readonly driftEpisodeId?: never }
      | {
          readonly phase: 'drift-status-request' | 'drift-human-escalation';
          readonly driftEpisodeId: DriftEpisodeId;
        }
    ))
  | (NotificationV2Base & (
      | {
          readonly phase: 'condition';
          readonly occurrenceIdentity: 'legacy-generation';
          readonly conditionOccurrence?: never;
          readonly qualifiedAt: IsoUtc;
          readonly driftEpisodeId?: never;
          readonly deliveryFence?: NotificationDeliveryFence;
        }
      | {
          readonly phase: 'condition';
          readonly occurrenceIdentity: 'agent-run';
          readonly conditionOccurrence: Extract<
            ConditionOccurrence,
            { readonly kind: 'agent-run' | 'run-final' }
          >;
          readonly qualifiedAt: IsoUtc;
          readonly driftEpisodeId?: never;
          readonly deliveryFence?: NotificationDeliveryFence;
        }
      | {
          readonly phase: 'condition';
          readonly occurrenceIdentity: 'committed-event';
          readonly conditionOccurrence: Extract<
            ConditionOccurrence,
            { readonly kind: 'committed-event' }
          >;
          readonly qualifiedAt: IsoUtc;
          readonly driftEpisodeId?: never;
          readonly deliveryFence?: NotificationDeliveryFence;
        }
      | {
          readonly phase: 'condition';
          readonly occurrenceIdentity: 'run-operation';
          readonly conditionOccurrence: Extract<
            ConditionOccurrence,
            { readonly kind: 'run-operation' }
          >;
          readonly qualifiedAt: IsoUtc;
          readonly driftEpisodeId?: never;
          readonly deliveryFence?: NotificationDeliveryFence;
        }
    ));

export type WatchEvaluationRuleOutcome =
  | { readonly kind: 'committed'; readonly notificationId: NotificationId }
  | { readonly kind: 'adopted'; readonly notificationId: NotificationId }
  | { readonly kind: 'legacy-adopted'; readonly legacyIds: readonly NotificationId[] }
  | { readonly kind: 'cooldown-suppressed'; readonly qualifiedAt: IsoUtc }
  | { readonly kind: 'not-matching' }
  | { readonly kind: 'inactive-current-policy' }
  | {
      readonly kind: 'pair-not-admitted';
      readonly signalEventId: string;
      readonly signalOccurredAt: IsoUtc;
      readonly signalTraceId: TraceCorrelationId;
      readonly subject: WatchSubject;
      readonly condition: WatchCondition;
      readonly reason: string;
    }
  | {
      readonly kind: 'failed-non-retryable';
      readonly code: B3ErrorCode;
      readonly reason: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

export type WatchEvaluationTrigger =
  | { readonly kind: 'event'; readonly eventId: string }
  | {
      readonly kind: 'deadline';
      readonly watchDeadlineId: WatchDeadlineId;
      readonly deadlineCreationRecordVersion: RecordVersion;
    };

/** Append-only per-rule progress for a resumable watcher evaluation. */
export interface WatchEvaluationProgress extends RecordEnvelope<
  WatchEvaluationId,
  'watchEvaluation'
> {
  readonly commandReceiptId: CommandReceiptId;
  readonly trigger: WatchEvaluationTrigger;
  readonly orderedWatchRuleIds: readonly WatchRuleId[];
  readonly attemptOrdinal: number;
  readonly completed: readonly {
    readonly attemptOrdinal: number;
    readonly watchRuleId: WatchRuleId;
    readonly evaluatedRecordVersion: RecordVersion;
    readonly outcome: WatchEvaluationRuleOutcome;
  }[];
  readonly nextRuleIndex: number;
  readonly state: 'running' | 'completed' | 'recovery-required';
  readonly recovery?: {
    readonly stage:
      | 'occurrence-derivation'
      | 'legacy-occurrence-adoption'
      | 'rule-version-fence';
    readonly reason: string;
  };
}

/** Durable progress while an Agent-recipient Notification changes target Run. */
export interface NotificationDeliveryFenceOperation extends RecordEnvelope<
  NotificationDeliveryFenceOperationId,
  'notificationDeliveryFenceOperation'
> {
  readonly notificationId: NotificationId;
  readonly previousTargetAgentRunId?: AgentRunId;
  readonly targetAgentRunId?: AgentRunId;
  readonly triggerEventId: string;
  readonly state: 'running' | 'queued-no-live-run' | 'completed' | 'recovery-required';
  readonly reason?: string;
}
