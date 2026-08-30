import type { DeliveryRunResult } from '../../contract/runtime.js';

const zeroRun: DeliveryRunResult = {
  claimed: 0,
  deferredBusy: 0,
  submitted: 0,
  failed: 0,
  observed: 0,
};

/** One step's contribution to the run tally, counted against a zeroed run. */
export const tally = (progress: Partial<DeliveryRunResult>): DeliveryRunResult => ({
  ...zeroRun,
  ...progress,
});

/** Two tallies combined into a new one; neither operand is disturbed. */
export const addProgress = (
  left: DeliveryRunResult,
  right: DeliveryRunResult,
): DeliveryRunResult => ({
  claimed: left.claimed + right.claimed,
  deferredBusy: left.deferredBusy + right.deferredBusy,
  submitted: left.submitted + right.submitted,
  failed: left.failed + right.failed,
  observed: left.observed + right.observed,
});
