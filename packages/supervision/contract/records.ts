import type {
  ActivityGeneration,
  AgentId,
  AgentRunId,
  HumanPrincipalId,
  IsoUtc,
  ProviderSessionId,
  RecordEnvelope,
  RuntimeEpochId,
} from '@novakai/foundation/contract';
import type { DurableDriftState } from './drift.js';
import type {
  DriftEpisodeId,
  NotificationId,
  ProviderUsageEvidenceId,
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
}

/** Notification fields shared by condition and drift phases. */
export interface NotificationBase extends RecordEnvelope<NotificationId, 'notification'> {
  readonly watchRuleId: WatchRuleId;
  readonly subject: WatchSubject;
  readonly recipient: NotificationRecipient;
  readonly conditionGeneration: number;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly state:
    | 'queued' | 'offered-to-endpoint' | 'transcript-observed'
    | 'acknowledged' | 'delivery-uncertain' | 'expired';
  readonly deliveryMode: WatchRule['deliveryMode'];
}

/** Durable notification, discriminated so ordinary and drift IDs cannot mix. */
export type Notification = NotificationBase & (
  | { readonly phase: 'condition'; readonly driftEpisodeId?: never }
  | {
      readonly phase: 'drift-status-request' | 'drift-human-escalation';
      readonly driftEpisodeId: DriftEpisodeId;
    }
);
