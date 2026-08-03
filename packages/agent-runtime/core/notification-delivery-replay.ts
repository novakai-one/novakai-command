// Reconcile a repeated Q7 command against Terminal and Supervision owner truth.
import {
  b3err, b3fail, b3ok,
  type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import type {
  NotificationDeliveryPort, NotificationTurnSubmission, StartNotificationTurnInput,
} from '../contract/notification-delivery.js';
import type { RunOperation } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';
import {
  getNotificationTurnSubmission, notificationOperationFor,
} from './notification-delivery-state.js';

type Submitted = Extract<
  NotificationTurnSubmission,
  { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
>;

export type DeliveryReplay =
  | { readonly kind: 'completed'; readonly outcome: Submitted }
  | {
      readonly kind: 'continue';
      readonly priorOperation: RunOperation | null;
      readonly ownerClaimed: boolean;
    };

const reader: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};

const isSubmitted = (value: NotificationTurnSubmission): value is Submitted =>
  value.state === 'submitted-confirmed' || value.state === 'submitted-unconfirmed';

function validateBinding(
  operation: RunOperation, input: StartNotificationTurnInput,
): B3Result<null> {
  if (operation.notificationId === input.notificationId) return b3ok(null);
  return b3fail(b3err(
    'IdempotencyConflict', 'delivery effect is bound to another Notification',
    {
      effectKey: input.effectKey,
      heldNotificationId: operation.notificationId,
      requestedNotificationId: input.notificationId,
    }, false,
  ));
}

function isFullyRecorded(operation: RunOperation): boolean {
  return operation.state === 'completed'
    && operation.completedStages.some((stage) => stage.stage === 'supervision-delivery-recorded');
}

async function ownerHasClaim(
  notifications: NotificationDeliveryPort,
  operation: RunOperation,
  input: StartNotificationTurnInput,
): Promise<B3Result<boolean>> {
  const reservationId = operation.notificationInputReservationId;
  if (reservationId === undefined) return b3ok(false);
  const ownerState = await notifications.getDeliveryState(reader, {
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    notificationInputReservationId: reservationId,
  });
  return ownerState.ok
    ? b3ok(ownerState.value.state !== 'queued')
    : ownerState;
}

export async function resolveDeliveryReplay(
  core: RunsCore,
  notifications: NotificationDeliveryPort,
  input: StartNotificationTurnInput,
): Promise<B3Result<DeliveryReplay>> {
  const found = await notificationOperationFor(core, input.effectKey);
  if (!found.ok) return found;
  const operation = found.value;
  if (operation === null) {
    return b3ok({ kind: 'continue', priorOperation: null, ownerClaimed: false });
  }
  const binding = validateBinding(operation, input);
  if (!binding.ok) return binding;
  const prior = await getNotificationTurnSubmission(core, input.effectKey);
  if (!prior.ok) return prior;
  if (isSubmitted(prior.value) && isFullyRecorded(operation)) {
    return b3ok({ kind: 'completed', outcome: prior.value });
  }
  if (prior.value.state === 'cancelled-not-submitted') {
    return b3fail(b3err(
      'IdempotencyConflict', 'the deterministic delivery reservation was cancelled',
      { effectKey: input.effectKey }, false,
    ));
  }
  const claimed = await ownerHasClaim(notifications, operation, input);
  if (!claimed.ok) return claimed;
  if (isSubmitted(prior.value) && !claimed.value) {
    return b3fail(b3err(
      'RecoveryRequired', 'Terminal submitted before Supervision recorded a claim',
      { notificationId: input.notificationId, effectKey: input.effectKey }, true,
    ));
  }
  return b3ok({ kind: 'continue', priorOperation: operation, ownerClaimed: claimed.value });
}
