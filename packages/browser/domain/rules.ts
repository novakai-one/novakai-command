// Pure session rules: lease math + the allocation decision. No I/O, so fully
// testable. The broker supplies the impure `instanceAlive` liveness check.
import type { Allocation, Session } from './types.js';

/** ISO instant `ttlMs` after `clock`. */
export function leaseExpiresAt(clock: Date, ttlMs: number): string {
  return new Date(clock.getTime() + ttlMs).toISOString();
}

/** True once the deadline is reached (equal instant counts as expired). */
export function isLeaseExpired(session: { leaseExpiresAt: string }, clock: Date): boolean {
  return new Date(session.leaseExpiresAt).getTime() <= clock.getTime();
}

/** Reuse a healthy session, otherwise launch fresh. */
export function decideAllocation(
  existing: Session | undefined,
  instanceAlive: boolean,
  clock: Date,
): Allocation {
  if (
    existing
    && existing.status === 'active'
    && instanceAlive
    && !isLeaseExpired(existing, clock)
  ) {
    return { kind: 'reuse', session: existing };
  }
  return { kind: 'launch' };
}
