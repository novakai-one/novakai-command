import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { DeliveryRunResult } from '../../contract/runtime.js';
import type { Timestamp } from '../../contract/types.js';
import type { DeliveryStore } from './delivery-store.js';
import { runDeliveryMaintenance } from './maintenance.js';
import { failDelivery, moveDelivery, type DeliveryMoveDependencies } from './move-delivery.js';
import { addProgress, tally } from './run-tally.js';
import {
  buildSendInput,
  type PairConversations,
  type RoutingAgents,
  type RoutingHold,
} from './send-input.js';
import { submitClaimedDelivery } from './submit-delivery.js';

interface DeliveryRouterDependencies {
  readonly store: DeliveryStore;
  readonly agents: RoutingAgents;
  readonly conversations: PairConversations;
  readonly providerSend: ProviderSend;
  readonly now: () => Timestamp;
}

/**
 * Runs one delivery pass: settle the maintenance queue (stale claims,
 * transcript-observed confirmations, confirmation deadlines), then route
 * every queued delivery to its recipient. This is the entry point of
 * delivery routing. A queued delivery only moves once its recipient Agent is
 * idle, so a provider session is never interrupted mid-turn; anything not
 * ready stays queued for the next pass.
 *
 * Crash recovery: a delivery claimed by a worker that never reports back is
 * freed by `runDeliveryMaintenance` on a later pass, a submitted delivery
 * whose send reached transcript evidence is settled by it there, and a
 * submitted delivery with no transcript evidence past the confirmation
 * deadline is failed loudly by it — a message either lands or visibly
 * fails, it never hangs silently.
 * Crash ownership: a throw while submitting a claimed delivery is caught and
 * recorded as that delivery's typed failure, while throws during listing,
 * observing, or transitioning propagate to the caller.
 */
export async function routePendingDeliveries(
  dependencies: DeliveryRouterDependencies,
): Promise<DeliveryRunResult> {
  let progress = await runDeliveryMaintenance(dependencies);
  const queued = (await dependencies.store.listPendingDeliveries())
    .filter((delivery) => delivery.state === 'queued');
  for (const delivery of queued) {
    progress = addProgress(progress, await routeOneDelivery(dependencies, delivery));
  }
  return progress;
}

/**
 * Routes one queued delivery: build its send input, claim it, then submit it
 * through the normal conversation send so the delivery gets the same
 * journaling and one-shot dispatch as any host send.
 */
async function routeOneDelivery(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
): Promise<DeliveryRunResult> {
  const built = await buildSendInput(dependencies, delivery);
  if (!built.ok) return recordHold(dependencies, delivery, built);
  const claimed = await moveDelivery(
    dependencies.store, delivery, 'queued', 'claimed', dependencies.now(),
  );
  if (!claimed) return tally({});
  return submitClaimedDelivery(dependencies, delivery, built.input);
}

/**
 * A deferred delivery stays queued for the next pass; an undeliverable one is
 * failed now with the routing reason it can never proceed.
 */
async function recordHold(
  dependencies: DeliveryMoveDependencies,
  delivery: PendingDelivery,
  outcome: RoutingHold,
): Promise<DeliveryRunResult> {
  if (outcome.kind === 'deferred') return tally({ deferredBusy: 1 });
  return failDelivery(
    dependencies, delivery, 'queued', { kind: 'routing-failed', detail: outcome.reason },
  );
}
