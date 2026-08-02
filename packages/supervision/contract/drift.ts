import type {
  ActivityGeneration,
  IsoUtc,
  ProviderTurnId,
  TerminalInputAttemptId,
} from '@novakai/foundation/contract';
import type {
  DriftEpisodeId,
  NotificationId,
  NotificationInputReservationId,
} from './identifiers.js';

/** The exact prompt carried forward by §9.2; adapters must not paraphrase it. */
export const DRIFT_STATUS_PROMPT =
  'Status check: reply with one line — what are you working on right now?' as const;

/** Cheap evidence order is contract data, not provider policy. */
export const DRIFT_FREE_EVIDENCE = [
  'terminal-liveness',
  'transcript-advance',
  'usage-delta',
] as const;

/** Exact activity-drift timing/counter constraints from §9.2. */
export const ACTIVITY_DRIFT_CONSTRAINTS = {
  minimumIntervalMs: 300_000,
  maximumIntervalMs: 600_000,
  defaultIntervalMs: 300_000,
  staleAfterIntervals: 2,
  escalateAfterConsecutive: 3,
} as const;

/** One canonical free-evidence sample persisted on the deadline (§9.2 step 1). */
export interface DriftEvidenceCheckpoint {
  readonly fingerprint: string;
  readonly terminalLiveness: 'live' | 'exited' | 'unknown';
  readonly terminalActivityGeneration: ActivityGeneration;
  readonly transcriptWatermark?: string;
  readonly usageActivityDigest?: string;
  readonly usageSourceCursor?: string;
  readonly evidenceRefs: readonly string[];
  readonly checkedAt: IsoUtc;
}

/** Claimed delivery has a durable reservation but no reply clock yet. */
export interface ClaimedDriftStatus {
  readonly episodeId: DriftEpisodeId;
  readonly effectKey: string;
  readonly notificationId: NotificationId;
  readonly state: 'delivery-claimed';
  readonly requestedAt: IsoUtc;
  readonly claimedAt: IsoUtc;
  readonly notificationInputReservationId: NotificationInputReservationId;
  readonly pendingMovementEvidenceRef?: string;
  readonly submittedAt?: never;
  readonly replyDueAt?: never;
  readonly providerTurnId?: never;
  readonly replyEvidenceRef?: never;
}

/** A queued, claimed, or submitted status request whose episode remains open. */
export type OutstandingDriftStatus =
  | {
      readonly episodeId: DriftEpisodeId;
      readonly effectKey: string;
      readonly notificationId: NotificationId;
      readonly state: 'queued';
      readonly requestedAt: IsoUtc;
      readonly submittedAt?: never;
      readonly replyDueAt?: never;
      readonly providerTurnId?: never;
      readonly replyEvidenceRef?: never;
    }
  | ClaimedDriftStatus
  | {
      readonly episodeId: DriftEpisodeId;
      readonly effectKey: string;
      readonly notificationId: NotificationId;
      readonly state: 'submitted-confirmed';
      readonly requestedAt: IsoUtc;
      readonly submittedAt: IsoUtc;
      readonly replyDueAt: IsoUtc;
      readonly providerTurnId: ProviderTurnId;
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly replyEvidenceRef?: never;
    }
  | {
      readonly episodeId: DriftEpisodeId;
      readonly effectKey: string;
      readonly notificationId: NotificationId;
      readonly state: 'submitted-unconfirmed';
      readonly requestedAt: IsoUtc;
      readonly submittedAt: IsoUtc;
      readonly replyDueAt: IsoUtc;
      readonly providerTurnId?: ProviderTurnId;
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly terminalInputAttemptId: TerminalInputAttemptId;
      readonly replyEvidenceRef?: never;
    };

/** The evidence-backed terminal state of a drift status request. */
export type ClosedDriftStatus =
  | {
      readonly episodeId: DriftEpisodeId;
      readonly effectKey: string;
      readonly notificationId: NotificationId;
      readonly state: 'replied';
      readonly closedAt: IsoUtc;
      readonly closureEvidenceRef: string;
    }
  | {
      readonly episodeId: DriftEpisodeId;
      readonly effectKey: string;
      readonly notificationId: NotificationId;
      readonly state: 'activity-observed-after-submission';
      readonly closedAt: IsoUtc;
      readonly closureEvidenceRef: string;
    }
  | {
      readonly episodeId: DriftEpisodeId;
      readonly effectKey: string;
      readonly notificationId: NotificationId;
      readonly state: 'cancelled-before-delivery';
      readonly closedAt: IsoUtc;
      readonly closureEvidenceRef: string;
    };

/** Fields shared by every durable activity-drift phase. */
export interface DurableDriftStateBase {
  readonly kind: 'activity-drift';
  readonly episodeOrdinal: number;
  readonly lastEvidence?: DriftEvidenceCheckpoint;
}

/** Exact durable drift phase union from §9.2. */
export type DurableDriftState = DurableDriftStateBase & (
  | {
      readonly phase: 'observing';
      readonly quietIntervals: 0;
      readonly episodeId?: never;
      readonly consecutiveUnansweredChecks: 0;
      readonly outstandingStatus?: never;
      readonly escalationNotificationId?: never;
      readonly lastClosedStatus?: ClosedDriftStatus;
    }
  | {
      readonly phase: 'observing';
      readonly quietIntervals: 1;
      readonly episodeId: DriftEpisodeId;
      readonly consecutiveUnansweredChecks: 0;
      readonly outstandingStatus?: never;
      readonly escalationNotificationId?: never;
      readonly lastClosedStatus?: ClosedDriftStatus;
    }
  | {
      readonly phase: 'status-outstanding';
      readonly quietIntervals: 2;
      readonly episodeId: DriftEpisodeId;
      readonly consecutiveUnansweredChecks: 0 | 1 | 2;
      readonly outstandingStatus: OutstandingDriftStatus;
      readonly escalationNotificationId?: never;
      readonly lastClosedStatus?: never;
    }
  | {
      readonly phase: 'escalated-waiting-human';
      readonly quietIntervals: 2;
      readonly episodeId: DriftEpisodeId;
      readonly consecutiveUnansweredChecks: 3;
      readonly outstandingStatus: Extract<
        OutstandingDriftStatus,
        { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
      >;
      readonly escalationNotificationId: NotificationId;
      readonly lastClosedStatus?: never;
    }
);
