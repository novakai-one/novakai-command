// Q7's Runtime-owned Notification delivery operation.
//
// This entry point owns command authority and delegates the three deep steps:
// reconcile durable owner truth, prepare the safe boundary, execute the
// journalled Terminal→Supervision sequence.
import {
  b3err, b3fail, b3ok,
  type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  NotificationTurnSubmission, StartNotificationTurnInput,
} from '../contract/notification-delivery.js';
import type { RunsCore } from './runs-context.js';
import {
  executeNotificationDelivery, prepareNotificationDelivery,
} from './notification-delivery-execution.js';
import { resolveDeliveryReplay } from './notification-delivery-replay.js';

export { getNotificationTurnSubmission } from './notification-delivery-state.js';

type Submitted = Extract<
  NotificationTurnSubmission,
  { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
>;

export async function startNotificationTurnAtSafeBoundary(
  core: RunsCore,
  context: SystemCommandContext<'sys_supervision'>,
  input: StartNotificationTurnInput,
): Promise<B3Result<Submitted>> {
  if (context.principal.kind !== 'system' || context.principal.id !== 'sys_supervision') {
    return b3fail(b3err(
      'PermissionDenied', 'only Supervision may request a Notification turn',
      { requiredPrincipal: 'sys_supervision' }, false,
    ));
  }
  const notifications = core.notifications;
  if (notifications === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'Supervision notification delivery is not composed',
      { reason: 'notification-delivery-not-composed' }, true,
    ));
  }
  const replay = await resolveDeliveryReplay(core, notifications, input);
  if (!replay.ok) return replay;
  if (replay.value.kind === 'completed') return b3ok(replay.value.outcome);
  const prepared = await prepareNotificationDelivery(
    core, notifications, input, replay.value.ownerClaimed,
  );
  if (!prepared.ok) return prepared;
  return executeNotificationDelivery(
    core, notifications, context, input, prepared.value, replay.value.priorOperation,
  );
}
