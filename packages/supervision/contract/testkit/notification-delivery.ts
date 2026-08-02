import assert from 'node:assert/strict';
import type {
  Notification,
  NotificationEvent,
  NotificationId,
} from '../index.js';
import { parseNotificationEvent } from '../event-validation.js';

/** Watcher-side provider half of the Notification emit/deliver seam. */
export interface NotificationEmitterProviderHarness {
  emitQueuedNotification(
    deliveryMode: Notification['deliveryMode'],
  ): Promise<NotificationEvent>;
}

/** Observable delivery acceptance before any Runtime safe-boundary work. */
export interface NotificationDeliveryObservation {
  readonly acceptedNotificationId: NotificationId;
  readonly effectOrder: readonly {
    readonly kind: 'queue-commit-observed' | 'delivery-effect-started';
    readonly notificationId: NotificationId;
  }[];
  readonly providerTurnsStartedSynchronously: number;
  readonly resultingState: Notification['state'];
}

/** Delivery-side consumer half of the Notification emit/deliver seam. */
export interface NotificationDeliveryConsumerHarness {
  acceptQueuedNotification(
    event: NotificationEvent,
  ): Promise<NotificationDeliveryObservation>;
}

const DELIVERY_MODES = [
  'queue-only',
  'next-turn-context',
  'start-turn',
] as const satisfies readonly Notification['deliveryMode'][];

/** Verify that all delivery modes cross the seam as committed queued records. */
export async function assertNotificationEmitterProviderContract(
  provider: NotificationEmitterProviderHarness,
): Promise<void> {
  for (const deliveryMode of DELIVERY_MODES) {
    const event = await provider.emitQueuedNotification(deliveryMode);
    const parsed = parseNotificationEvent(event);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
    assert.equal(event.kind, 'supervision.notification.changed');
    assert.equal(event.sourceOwner, 'supervision');
    assert.equal(event.payload.kind, 'notification');
    assert.equal(event.payload.state, 'queued');
    assert.equal(event.payload.deliveryMode, deliveryMode);
  }
}

/** Verify queue-before-effect and that acceptance itself never starts a turn. */
export async function assertNotificationDeliveryConsumerContract(
  provider: NotificationEmitterProviderHarness,
  consumer: NotificationDeliveryConsumerHarness,
): Promise<void> {
  for (const deliveryMode of DELIVERY_MODES) {
    const event = await provider.emitQueuedNotification(deliveryMode);
    const observed = await consumer.acceptQueuedNotification(event);
    assert.equal(observed.acceptedNotificationId, event.payload.id);
    assert.deepEqual(observed.effectOrder, [
      { kind: 'queue-commit-observed', notificationId: event.payload.id },
      { kind: 'delivery-effect-started', notificationId: event.payload.id },
    ]);
    assert.equal(observed.providerTurnsStartedSynchronously, 0);
    assert.equal(observed.resultingState, 'queued');
  }
}
