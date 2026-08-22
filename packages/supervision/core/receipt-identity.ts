// core/receipt-identity.ts — deadline-evaluation identity (SUPFIX-06; split
// from compose.ts, SUPFIX step 0).
//
// The old identity was the poll TIMESTAMP: every 1 s pass minted a brand-new
// clientOpId, so replay-safe receipts could never dedupe and every idle pass
// appended a receipt pair + traces (~0.7 GB/day; 952,948 no-op receipt rows by
// 2026-08-22). The identity is now the DUE WORK itself:
//
//   - no due deadline  → no command, no receipt, zero durable writes;
//   - a due set        → clientOpId derived from the sorted (id, dueAt) pairs,
//                        so a crash-and-retry of the same due work replays the
//                        same command instead of minting a new one.
//
// Firing semantics stay honest: evaluation is at-least-once (a pass can repeat
// after a crash); at most one Notification lands per occurrence, deduped by
// the deterministic Notification identity inside settleOne.
import { deriveClientOpId, type IsoUtc } from '@novakai/foundation/contract';
import type { B3ClientOpId } from '@novakai/foundation/contract';
import type { WatchDeadline } from '../contract/index.js';

/**
 * The ONE authority for "which deadlines are due at this instant" — shared by
 * the compose-level peek and the evaluator, so the peek can never disagree
 * with the work it gates.
 */
export function selectDueDeadlines(
  deadlines: readonly WatchDeadline[],
  observedAt: IsoUtc,
): readonly WatchDeadline[] {
  return deadlines
    .filter((deadline) => deadline.state === 'armed' || deadline.state === 'claimed')
    .filter((deadline) => String(deadline.dueAt) <= String(observedAt))
    .sort((left, right) => String(left.dueAt).localeCompare(String(right.dueAt))
      || String(left.id).localeCompare(String(right.id)));
}

/** Stable identity for one due set: same due work → same clientOpId. */
export function dueDeadlineEvaluationClientOpId(
  due: readonly WatchDeadline[],
): B3ClientOpId {
  const key = due
    .map((deadline) => `${String(deadline.id)}@${String(deadline.dueAt)}`)
    .join(',');
  return deriveClientOpId(`b3v4:evaluate-due-deadlines:${key}`);
}
