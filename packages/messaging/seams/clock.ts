/**
 * Clock / ID factory seam — Messaging-Seams.md §5.
 *
 * A seam because deterministic tests require substitution (Plan §14), not
 * because production varies. `now()` feeds createdAt/deadlines only — ordering
 * is the store sequence, always (DEC-19).
 *
 * Failure vocabulary (§5.2, halt-class): a clock/ID failure means the core
 * cannot honestly proceed. Adapters signal it by THROWING a MessagingError
 * with name DependencyUnavailable, fields.dependency = "clock",
 * retryable = false (see `clockUnavailable`). Halt-class, like StoreCorrupt:
 * it is never a typed per-operation outcome.
 */

import { MessagingError } from "../public/contract/index.js";
import type { IdKind, IdTypeMap, Timestamp } from "../public/contract/index.js";

export interface ClockIds {
  /** Display-only timestamp; NEVER an ordering key (DEC-19). */
  now(): Timestamp;
  /** Mint a branded ID matching the contract-source pattern for the kind. Never reissued within one store's lifetime. */
  newId<Kind extends IdKind>(kind: Kind): IdTypeMap[Kind];
}

/** The §5.2 halt-class failure: DependencyUnavailable{dependency: "clock", retryable: false}. */
export function clockUnavailable(detail: string): MessagingError {
  return new MessagingError("DependencyUnavailable", {
    message: `clock/ID dependency failure: ${detail}`,
    retryable: false,
    fields: { dependency: "clock", retryable: false },
  });
}
