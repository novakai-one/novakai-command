import test from 'node:test';
import {
  assertNotificationDeliveryConsumerContract,
  assertNotificationEmitterProviderContract,
  type NotificationDeliveryConsumerHarness,
  type NotificationEmitterProviderHarness,
} from '../contract/testkit/index.js';
import { queuedNotificationEvent } from './fixtures.js';

const provider: NotificationEmitterProviderHarness = {
  emitQueuedNotification: async (deliveryMode) => queuedNotificationEvent(deliveryMode),
};

test('watcher provider emits a durable queued Notification before delivery', async () => {
  await assertNotificationEmitterProviderContract(provider);
});

test('notification consumer preserves queue-first delivery and non-starting modes', async () => {
  const consumer: NotificationDeliveryConsumerHarness = {
    acceptQueuedNotification: async (event) => ({
      acceptedNotificationId: event.payload.id,
      queueCommittedBeforeDeliveryEffect: event.payload.state === 'queued',
      providerTurnsStartedSynchronously: 0,
      resultingState: 'queued',
    }),
  };
  await assertNotificationDeliveryConsumerContract(provider, consumer);
});
