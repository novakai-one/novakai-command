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
  }): void;
}

export function createFakeNotificationDelivery(): FakeNotificationDelivery {
  const authorities = new Map<NotificationId, NotificationDeliveryAuthorityFacts>();
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
        authoritySource: {
          kind: 'watch-rule', watchRuleId: 'watchRule_fake-notification-delivery',
        },
      });
    },
    async getAuthority(_principal, notificationId) {
      const authority = authorities.get(notificationId);
      return authority === undefined
        ? b3fail(b3err('ValidationFailed', 'unknown fake Notification', { notificationId }, false))
        : b3ok(authority);
    },
    async claim(input) {
      const authority = authorities.get(input.notificationId);
      if (authority === undefined || authority.deliveryEffectKey !== input.expectedEffectKey) {
        return b3fail(b3err(
          'IdempotencyConflict', 'fake claim does not match its authority', {}, false,
        ));
      }
      fake.claims.push(input.expectedEffectKey);
      return b3ok({
        phase: 'ordinary' as const,
        notificationRecordVersion: 2 as never,
      });
    },
    async recordSubmission(input) {
      fake.submissions.push(input.effectKey);
      return b3ok(null);
    },
  };
  return fake;
}
