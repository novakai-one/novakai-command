// Agent Runtime's complete Notification delivery seam.
//
// Keeping the command/query result and the narrow Supervision port together
// makes one bounded contract module for the durable operation.
import type {
  ActivityGeneration, AgentRunId, AuthenticatedPrincipal, B3Result, IsoUtc,
  NotificationId, NotificationInputReservationId, ProviderTurnId, RecordVersion,
  ResolvedLaunchPlanId, TerminalInputAttemptId,
} from '@novakai/foundation/contract';

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
    }
  | { readonly state: 'absent' }
  | {
      readonly state: 'reserved-not-claimed';
      readonly notificationInputReservationId: NotificationInputReservationId;
    }
  | {
      readonly state: 'claimed-pending-submission';
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly notificationId: NotificationId;
    }
  | {
      readonly state: 'cancelled-not-submitted';
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly cancelledAt: IsoUtc;
    };

export interface StartNotificationTurnInput {
  readonly notificationId: NotificationId;
  readonly agentRunId: AgentRunId;
  readonly effectKey: string;
  readonly expectedActivityGeneration: ActivityGeneration;
}

export interface NotificationDeliveryAuthorityFacts {
  readonly notificationId: NotificationId;
  readonly notificationRecordVersion: RecordVersion;
  readonly watchRuleId: string;
  readonly agentRunId: AgentRunId;
  readonly deliveryEffectKey: string;
  readonly activityGeneration: ActivityGeneration;
  readonly deliveryMode: 'start-turn';
  readonly inputText: string;
  readonly semanticSource: 'watcher-status-request' | 'notification-start-turn';
  readonly authoritySource:
    | { readonly kind: 'watch-rule'; readonly watchRuleId: string }
    | { readonly kind: 'launch-plan'; readonly launchPlanId: ResolvedLaunchPlanId };
}

export type NotificationDeliveryClaimFacts =
  | {
      readonly phase: 'ordinary';
      readonly notificationRecordVersion: RecordVersion;
    }
  | {
      readonly phase: 'drift-status-request';
      readonly notificationRecordVersion: RecordVersion;
      readonly watchDeadlineId: string;
      readonly watchDeadlineRecordVersion: RecordVersion;
      readonly driftEpisodeId: string;
    };

export type NotificationDeliveryStateFacts =
  | { readonly state: 'queued' }
  | {
      readonly state:
        | 'delivery-claimed' | 'submitted-confirmed' | 'submitted-unconfirmed';
      readonly notificationInputReservationId: NotificationInputReservationId;
    };

export interface NotificationDeliveryPort {
  getAuthority(
    principal: AuthenticatedPrincipal, notificationId: NotificationId,
  ): Promise<B3Result<NotificationDeliveryAuthorityFacts>>;

  getDeliveryState(
    principal: AuthenticatedPrincipal,
    input: {
      readonly notificationId: NotificationId;
      readonly effectKey: string;
      readonly notificationInputReservationId: NotificationInputReservationId;
    },
  ): Promise<B3Result<NotificationDeliveryStateFacts>>;

  claim(input: {
    readonly notificationId: NotificationId;
    readonly expectedNotificationRecordVersion: RecordVersion;
    readonly expectedEffectKey: string;
    readonly notificationInputReservationId: NotificationInputReservationId;
    readonly expectedActivityGeneration: ActivityGeneration;
  }): Promise<B3Result<NotificationDeliveryClaimFacts>>;

  recordSubmission(input: {
    readonly claim: NotificationDeliveryClaimFacts;
    readonly notificationId: NotificationId;
    readonly effectKey: string;
    readonly notificationInputReservationId: NotificationInputReservationId;
    readonly terminalInputAttemptId: TerminalInputAttemptId;
    readonly outcome:
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
  }): Promise<B3Result<null>>;
}
