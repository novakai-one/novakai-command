import type { Timestamp } from '../contract/types.js';

/**
 * Brands a trusted host clock once, at the composition seam. Inside the
 * capability every timestamp is already a `Timestamp`; this is the single
 * place the raw `() => string` clock crosses into branded time, so the cast
 * has exactly one owner.
 */
export const brandClock = (rawClock: () => string): (() => Timestamp) =>
  () => rawClock() as Timestamp;
