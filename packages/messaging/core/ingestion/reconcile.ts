import type { ProviderSourceStat } from '../../contract/ports/provider-transcript-source.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';

type EvidenceResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'unique'; readonly session: ProviderSession }
  | { readonly kind: 'ambiguous'; readonly sessionIds: readonly string[] };

/** Typed refusal raised when native source evidence names more than one session. */
export class AmbiguousProviderSessionEvidenceError extends Error {
  override readonly name = 'AmbiguousProviderSessionEvidenceError';

  constructor(
    readonly sourceId: string,
    readonly resumeId: string | undefined,
    readonly sessionIds: readonly string[],
  ) {
    super(`Provider evidence for ${sourceId} matches multiple sessions: ${sessionIds.join(', ')}`);
  }
}

/** Resolves historical source/resume evidence only when it names one session. */
export function reconcileProviderSessionEvidence(
  sessions: readonly ProviderSession[],
  source: ProviderSourceStat,
  resumeId: string | undefined,
): EvidenceResolution {
  const matches = sessions.filter((candidate) =>
    candidate.sourceIds.includes(source.sourceId)
    || (resumeId !== undefined && candidate.resumeId === resumeId));
  const unique = [...new Map(matches.map((session) => [session.id, session])).values()];
  if (unique.length === 0) return { kind: 'none' };
  if (unique.length === 1) return { kind: 'unique', session: unique[0]! };
  return {
    kind: 'ambiguous',
    sessionIds: unique.map((session) => session.id).sort(),
  };
}
