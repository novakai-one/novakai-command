/**
 * Store-seam §6 → public contract mapping (Schemas §8, R6). One place; the
 * pipeline, orchestrator, and query layer all map through here.
 *
 * Never public: StateConflict / RevisionConflict (normal concurrency outcomes —
 * the core re-reads and re-decides; surfacing one is a core bug). RecordNotFound
 * is context-dependent (UnknownThread / UnknownMessage / …) so callers map it
 * themselves. CursorInvalid maps to ValidationFailed.
 */

import { MessagingError } from "../contract/schemas.js";
import type { Cursor, ValidationIssue } from "../contract/schemas.js";
import type { StoreError } from "../contract/ports/store.js";

export function storeDependencyError(error: StoreError): MessagingError {
  switch (error.name) {
    case "StoreUnavailable":
      return new MessagingError("DependencyUnavailable", {
        message: `store unavailable: ${error.message}`,
        retryable: true,
        fields: { dependency: "store", retryable: true },
      });
    case "StorageExhausted":
      return new MessagingError("DependencyUnavailable", {
        message: `storage exhausted: ${error.message}`,
        retryable: false,
        fields: { dependency: "store", retryable: false },
      });
    case "StoreCorrupt":
      return new MessagingError("DependencyUnavailable", {
        message: `store corrupt: ${error.message} — operator intervention required`,
        retryable: false,
        fields: { dependency: "store", retryable: false },
      });
    default:
      // StateConflict / RevisionConflict / RecordNotFound / CursorInvalid /
      // IdempotencyConflict / SequenceExhausted must be handled by the caller
      // in context — reaching here is a core bug.
      throw new Error(`storeDependencyError: unhandled store error ${error.name}`);
  }
}

export function cursorInvalidError(cursor: Cursor): MessagingError {
  const issues: ValidationIssue[] = [{ path: "cursor", message: `malformed or foreign cursor ${JSON.stringify(cursor)}` }];
  return new MessagingError("ValidationFailed", {
    message: `validation failed: cursor: malformed or foreign cursor`,
    retryable: false,
    fields: { issues },
  });
}
