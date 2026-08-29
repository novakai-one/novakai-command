import type { PendingDeliveryState } from '../../contract/types.js';

const permitted: Readonly<Record<PendingDeliveryState, readonly PendingDeliveryState[]>> = {
  queued: ['claimed', 'failed'],
  claimed: ['submitted-confirmed', 'submitted-unconfirmed', 'failed'],
  'submitted-confirmed': ['transcript-observed', 'failed'],
  'submitted-unconfirmed': ['transcript-observed'],
  'transcript-observed': [],
  failed: [],
};

/**
 * Rejects a PendingDelivery state change that is not on the permitted path,
 * and rejects any failure recorded without a reason. A delivery may only move
 * forward through proven states, so it can never skip submission or lose the
 * evidence of why it failed.
 *
 * A violation here is a programmer defect — every transition is chosen by
 * Messaging's own router and stores, never derived from outside input — so it
 * throws rather than returning a typed outcome. The throw stays a plain Error
 * because the contract error catalogue names host-visible failures (invalid
 * input, unknown Agent, dependency outage, idempotency conflict) and has no
 * entry for an internal state-machine breach; the send journal's guard in
 * adapters/stores/send-journal-state.ts throws plain Errors for the same
 * class of defect.
 */
export function assertPendingDeliveryTransition(
  id: string,
  from: PendingDeliveryState,
  nextState: PendingDeliveryState,
  failure?: string,
): void {
  if (!permitted[from].includes(nextState)) {
    throw new Error(`PendingDelivery ${id} cannot move ${from} -> ${nextState}`);
  }
  if (nextState === 'failed' && (failure === undefined || failure.trim().length === 0)) {
    throw new Error(`PendingDelivery ${id} failure requires evidence`);
  }
}
