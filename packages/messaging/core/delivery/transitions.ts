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
 */
export function assertPendingDeliveryTransition(
  id: string,
  from: PendingDeliveryState,
  to: PendingDeliveryState,
  failure?: string,
): void {
  if (!permitted[from].includes(to)) {
    throw new Error(`PendingDelivery ${id} cannot move ${from} -> ${to}`);
  }
  if (to === 'failed' && (failure === undefined || failure.trim().length === 0)) {
    throw new Error(`PendingDelivery ${id} failure requires evidence`);
  }
}
