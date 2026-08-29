import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { DeliveryRunResult } from '../../contract/runtime.js';
import type { Timestamp } from '../../contract/types.js';
import type { DeliveryStore } from './delivery-store.js';
import { moveDelivery, type DeliveryMoveDependencies } from './move-delivery.js';
import { tally } from './run-tally.js';
import { clientOpIdFor } from './send-input.js';

/** A claim older than this was abandoned by its worker and must be re-examined. */
const CLAIM_TIMEOUT_MS = 30_000;

/**
 * Confirmation means the message landed in the transcript, which a healthy
 * path shows within seconds of dispatch; two minutes covers a cold CLI
 * start, and past that the honest state is failed — never a silent hang.
 */
const CONFIRMATION_TIMEOUT_MS = 120_000;

/** A delivery whose last state change is longer ago than timeoutMs is overdue. */
const overdue = (delivery: PendingDelivery, timestamp: Timestamp, timeoutMs: number): boolean =>
  Date.parse(delivery.updatedAt) <= Date.parse(timestamp) - timeoutMs;

/**
 * The housekeeping half of one delivery pass: close claims that went stale,
 * mark submitted deliveries whose send is now confirmed in the transcript,
 * then fail the ones past the confirmation deadline. Runs before routing so
 * the pass starts from settled evidence. Order matters: observation runs
 * before the deadline so fresh evidence always wins.
 *
 * Crash ownership: throws from listing, observing, or transitioning
 * propagate to the caller — only per-delivery submission throws (owned by
 * submit-delivery.ts) are caught and recorded as delivery evidence.
 */
export async function runDeliveryMaintenance(
  dependencies: DeliveryMoveDependencies,
): Promise<DeliveryRunResult> {
  const timestamp = dependencies.now();
  return tally({
    submitted: await closeStaleClaims(dependencies, timestamp),
    observed: await observeConfirmedDeliveries(dependencies.store, timestamp),
    failed: await failUnconfirmedDeliveries(dependencies, timestamp),
  });
}

/**
 * Frees deliveries whose claim has gone stale — a worker claimed them but
 * never reported back within the timeout — by moving them to
 * submitted-unconfirmed so the transcript can still prove what happened.
 */
async function closeStaleClaims(
  dependencies: DeliveryMoveDependencies,
  timestamp: Timestamp,
): Promise<number> {
  const stale = (delivery: PendingDelivery): boolean =>
    delivery.state === 'claimed' && overdue(delivery, timestamp, CLAIM_TIMEOUT_MS);
  let submitted = 0;
  for (const delivery of (await dependencies.store.listPendingDeliveries()).filter(stale)) {
    if (await moveDelivery(
      dependencies.store, delivery, 'claimed', 'submitted-unconfirmed', timestamp,
    )) {
      submitted += 1;
    }
  }
  return submitted;
}

/** Only a delivery waiting on transcript evidence can be observed. */
const awaitsObservation = (delivery: PendingDelivery): boolean =>
  delivery.state === 'submitted-confirmed' || delivery.state === 'submitted-unconfirmed';

/**
 * Advances submitted deliveries to transcript-observed once the send they
 * produced is confirmed in the transcript, closing the delivery loop.
 */
async function observeConfirmedDeliveries(
  store: DeliveryStore,
  timestamp: Timestamp,
): Promise<number> {
  const journals = new Map((await store.listSendJournals()).map((item) => [item.clientOpId, item]));
  let observed = 0;
  for (const delivery of await store.listPendingDeliveries()) {
    observed += await observeIfConfirmed(store, delivery, journals, timestamp);
  }
  return observed;
}

/** Advances one submitted delivery to transcript-observed when its send journal is confirmed. */
async function observeIfConfirmed(
  store: DeliveryStore,
  delivery: PendingDelivery,
  journals: ReadonlyMap<string, SendJournal>,
  timestamp: Timestamp,
): Promise<number> {
  if (!awaitsObservation(delivery)) return 0;
  if (journals.get(clientOpIdFor(delivery))?.state !== 'confirmed') return 0;
  if (!await moveDelivery(store, delivery, delivery.state, 'transcript-observed', timestamp)) {
    return 0;
  }
  return 1;
}

/**
 * Fails a delivery stuck in submitted-unconfirmed past the confirmation
 * deadline: its send never produced transcript evidence, so the honest state
 * is failed with the deadline as evidence.
 */
async function failUnconfirmedDeliveries(
  dependencies: DeliveryMoveDependencies,
  timestamp: Timestamp,
): Promise<number> {
  const stranded = (delivery: PendingDelivery): boolean =>
    delivery.state === 'submitted-unconfirmed'
    && overdue(delivery, timestamp, CONFIRMATION_TIMEOUT_MS);
  let failed = 0;
  for (const delivery of (await dependencies.store.listPendingDeliveries()).filter(stranded)) {
    const moved = await moveDelivery(
      dependencies.store, delivery, 'submitted-unconfirmed', 'failed', timestamp,
      { kind: 'confirmation-timeout', detail: 'no transcript evidence within the confirmation deadline' },
    );
    if (moved) failed += 1;
  }
  return failed;
}
