import type {
  DeliveryFailure,
  PendingDelivery,
} from '../../contract/records/pending-delivery.js';
import type { DeliveryRunResult } from '../../contract/runtime.js';
import type { Timestamp } from '../../contract/types.js';
import { present } from '../sparse.js';
import type { DeliveryStore } from './delivery-store.js';
import { tally } from './run-tally.js';

/** The two fields every state move needs: the store to write through and the clock. */
export interface DeliveryMoveDependencies {
  readonly store: DeliveryStore;
  readonly now: () => Timestamp;
}

/**
 * Moves one delivery to a new state when it is still in the expected one.
 * Compare-and-set: if another worker moved it first, nothing changes and the
 * caller counts nothing.
 */
export async function moveDelivery(
  store: DeliveryStore,
  delivery: PendingDelivery,
  expectedState: PendingDelivery['state'],
  state: PendingDelivery['state'],
  timestamp: Timestamp,
  failure?: DeliveryFailure,
): Promise<boolean> {
  const moved = await store.transitionPendingDelivery({
    id: delivery.id,
    expectedState,
    state,
    updatedAt: timestamp,
    ...present('failure', failure),
  });
  return moved.changed;
}

/** Records a delivery as failed with the typed evidence of why it can never proceed. */
export async function failDelivery(
  dependencies: DeliveryMoveDependencies,
  delivery: PendingDelivery,
  expectedState: 'queued' | 'claimed',
  failure: DeliveryFailure,
): Promise<DeliveryRunResult> {
  const moved = await moveDelivery(
    dependencies.store, delivery, expectedState, 'failed', dependencies.now(), failure,
  );
  if (!moved) return tally({});
  return tally({ failed: 1 });
}
