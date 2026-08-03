import {
  b3err, b3fail, b3ok,
  type ActivityGeneration, type AgentRunId, type NotificationId,
} from '@novakai/foundation/contract';
import type {
  NotificationDeliveryAuthorityFacts, NotificationDeliveryPort,
} from '../contract/ports.js';

export interface FakeNotificationDelivery extends NotificationDeliveryPort {
  readonly claims: string[];
  readonly submissions: string[];
  authorize(input: {
    readonly notificationId: NotificationId;
    readonly agentRunId: AgentRunId;
    readonly effectKey: string;
    readonly activityGeneration: ActivityGeneration;
    readonly inputText: string;
    readonly semanticSource?: 'watcher-status-request' | 'notification-start-turn';
  }): void;
}

export function createFakeNotificationDelivery(): FakeNotificationDelivery {
  const authorities = new Map<NotificationId, NotificationDeliveryAuthorityFacts>();
  const states = new Map<NotificationId, {
    readonly state: 'queued' | 'delivery-claimed' | 'submitted-confirmed' | 'submitted-unconfirmed';
    readonly notificationInputReservationId?: Parameters<
      NotificationDeliveryPort['claim']
    >[0]['notificationInputReservationId'];
  }>();
  const fake: FakeNotificationDelivery = {
    claims: [],
    submissions: [],
    authorize(input) {
      authorities.set(input.notificationId, {
        notificationId: input.notificationId,
        notificationRecordVersion: 1 as never,
        watchRuleId: 'watchRule_fake-notification-delivery',
        agentRunId: input.agentRunId,
        deliveryEffectKey: input.effectKey,
        activityGeneration: input.activityGeneration,
        deliveryMode: 'start-turn',
        inputText: input.inputText,
        semanticSource: input.semanticSource ?? 'notification-start-turn',
        authoritySource: {
          kind: 'watch-rule', watchRuleId: 'watchRule_fake-notification-delivery',
        },
      });
      states.set(input.notificationId, { state: 'queued' });
    },
    async getAuthority(_principal, notificationId) {
      const authority = authorities.get(notificationId);
      return authority === undefined
        ? b3fail(b3err('ValidationFailed', 'unknown fake Notification', { notificationId }, false))
        : b3ok(authority);
    },
    async getDeliveryState(_principal, input) {
      const state = states.get(input.notificationId);
      if (state === undefined) {
        return b3fail(b3err('ValidationFailed', 'unknown fake Notification', {}, false));
      }
      if (state.state === 'queued') return b3ok({ state: 'queued' });
      if (state.notificationInputReservationId !== input.notificationInputReservationId) {
        return b3fail(b3err(
          'IdempotencyConflict', 'fake Notification belongs to another reservation', {}, false,
        ));
      }
      return b3ok({
        state: state.state,
        notificationInputReservationId: state.notificationInputReservationId,
      });
    },
    async claim(input) {
      const authority = authorities.get(input.notificationId);
      if (authority === undefined || authority.deliveryEffectKey !== input.expectedEffectKey) {
        return b3fail(b3err(
          'IdempotencyConflict', 'fake claim does not match its authority', {}, false,
        ));
      }
      fake.claims.push(input.expectedEffectKey);
      states.set(input.notificationId, {
        state: 'delivery-claimed',
        notificationInputReservationId: input.notificationInputReservationId,
      });
      return b3ok({
        phase: 'ordinary' as const,
        notificationRecordVersion: 2 as never,
      });
    },
    async recordSubmission(input) {
      fake.submissions.push(input.effectKey);
      states.set(input.notificationId, {
        state: input.outcome.state,
        notificationInputReservationId: input.notificationInputReservationId,
      });
      return b3ok(null);
    },
  };
  return fake;
}
