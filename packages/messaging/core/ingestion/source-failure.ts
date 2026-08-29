import type { IngestSourceFailure } from "../../contract/runtime.js";
import type { ProviderSourceStat } from "../../contract/ports/provider-transcript-source.js";
import { MessagingError } from "../../contract/types.js";
import { AmbiguousProviderSessionEvidenceError } from "./reconcile.js";

/** Maps a thrown cause to its typed failure kind; the message stays for humans. */
export const failureFor = (
  source: ProviderSourceStat,
  cause: unknown,
): IngestSourceFailure => ({
  sourceId: source.sourceId,
  provider: source.provider,
  kind: failureKindFor(cause),
  message: cause instanceof Error ? cause.message : String(cause),
});

/** Known typed causes name their kind; anything else is unexpected. */
const failureKindFor = (cause: unknown): IngestSourceFailure['kind'] => {
  if (cause instanceof AmbiguousProviderSessionEvidenceError) return 'ambiguous-evidence';
  if (cause instanceof MessagingError && cause.name === 'IdempotencyConflict') {
    return 'checkpoint-conflict';
  }
  return 'unexpected';
};
