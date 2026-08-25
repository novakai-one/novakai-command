import type { PendingDeliveryState } from '../../contract/types.js';

const permitted: Readonly<Record<PendingDeliveryState, readonly PendingDeliveryState[]>> = {
  queued: ['claimed', 'failed'],
  claimed: ['submitted-confirmed', 'submitted-unconfirmed', 'failed'],
  'submitted-confirmed': ['transcript-observed', 'failed'],
  'submitted-unconfirmed': ['transcript-observed'],
  'transcript-observed': [],
  failed: [],
};

/** Refuses every rewind, skip and evidence-free failure. */
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
