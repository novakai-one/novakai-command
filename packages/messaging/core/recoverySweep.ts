/**
 * core/recoverySweep — DEC-21 (A7). DEC-09 reads commit-before-effect AND
 * eventual-effect: a crash between commit and settle leaves an acceptance
 * with effectsPending = true; this sweep drives every such acceptance to
 * completion. The composition root runs it at startup, before accepting
 * connections (standalone) or on demand (embedded handle).
 *
 * Idempotent by construction (Store-Seam §7 crash-window honesty): the
 * orchestrator's attempt decisions re-read CURRENT state and settle through
 * the store CAS, delivery transitions are idempotent under CAS, and
 * markEffectsSettled is idempotent — so re-driving an already-driven
 * acceptance is a no-op, and the sweep is safe to run with zero pending.
 *
 * The sweep drives acceptances one at a time in sequence order; a failure on
 * one acceptance is recorded and the sweep CONTINUES (a poisoned acceptance
 * must not starve the others) — the failed one keeps its marker and is
 * re-driven by the next sweep.
 */

import type { Cursor, MessageId } from "../contract/schemas.js";
import { MessagingError } from "../contract/schemas.js";
import type { MessagingStore } from "../contract/ports/store.js";
import type { DeliveryOrchestrator } from "./deliveryOrchestrator.js";
import { storeDependencyError } from "./storeErrors.js";

export interface RecoverySweepFailure {
  messageId: MessageId;
  error: MessagingError;
}

export interface RecoverySweepReport {
  /** Acceptances found with effectsPending = true. */
  found: number;
  /** Acceptances re-driven and settled this run. */
  settled: number;
  /** Acceptances whose re-drive failed (marker kept for the next sweep). */
  failures: RecoverySweepFailure[];
}

export interface RecoverySweepDeps {
  store: MessagingStore;
  orchestrator: DeliveryOrchestrator;
}

export async function runRecoverySweep(deps: RecoverySweepDeps): Promise<RecoverySweepReport> {
  const { store, orchestrator } = deps;
  const report: RecoverySweepReport = { found: 0, settled: 0, failures: [] };

  let cursor: Cursor | undefined;
  for (;;) {
    const page = await store.listPendingAcceptances(
      cursor !== undefined ? { cursor } : {},
    );
    if (page.kind === "error") throw storeDependencyError(page.error);

    for (const acceptance of page.value.acceptances) {
      report.found += 1;
      try {
        const message = await store.getMessage(acceptance.messageId);
        if (message.kind === "error") throw storeDependencyError(message.error);
        const deliveries = await store.getDeliveries(acceptance.messageId);
        if (deliveries.kind === "error") throw storeDependencyError(deliveries.error);
        // No blocked-set re-read (F2/§11.7): R4 blocked recipients committed
        // terminal failed INSIDE commitAcceptance, so the sweep's re-drive
        // needs only the committed Deliveries — attemptDecision's
        // current-state re-read skips the terminal ones. §11.6's snapshot
        // read here (and its RecordNotFound laundering hazard) is gone.

        // Re-drive the post-commit effects: the SAME orchestrator entry point
        // the send pipeline uses (R5 attempt decisions; CAS-idempotent), then
        // clear the marker (DEC-21). urgentDowngraded is the persisted value
        // (§11.3) — the honest source at re-drive time.
        await orchestrator.onAcceptance(
          message.value,
          deliveries.value,
          acceptance.urgentDowngraded ?? false,
        );
        const settled = await store.markEffectsSettled(acceptance.messageId);
        if (settled.kind === "error") throw storeDependencyError(settled.error);
        report.settled += 1;
      } catch (cause) {
        report.failures.push({
          messageId: acceptance.messageId,
          error:
            cause instanceof MessagingError
              ? cause
              : new MessagingError("DependencyUnavailable", {
                  message: `recovery sweep re-drive failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  retryable: true,
                  fields: { dependency: "store", retryable: true },
                }),
        });
        // Continue: one failed acceptance never starves the rest.
      }
    }

    if (page.value.nextCursor === undefined) return report;
    cursor = page.value.nextCursor;
  }
}
