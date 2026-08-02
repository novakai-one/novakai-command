import { deterministicId, type ActivityGeneration } from '@novakai/foundation/contract';
import type { DriftEpisodeId, WatchRuleId } from './identifiers.js';
import type { WatchCondition } from './records.js';

/** Exact scalar tuple fixed by §9.2 step 3 for one drift episode. */
export interface DriftEpisodeIdentityInput {
  readonly watchRuleId: WatchRuleId;
  readonly subjectKey: string;
  readonly activityGeneration: ActivityGeneration;
  readonly fingerprint: string;
  readonly episodeOrdinal: number;
}

/** Canonical §4.1/§9.2 drift-episode identity derivation. */
export function deriveDriftEpisodeId(input: DriftEpisodeIdentityInput): DriftEpisodeId {
  return deterministicId('driftEpisode', [
    input.watchRuleId,
    input.subjectKey,
    String(input.activityGeneration),
    input.fingerprint,
    String(input.episodeOrdinal),
  ]) as DriftEpisodeId;
}

/**
 * The notification tuple fixed by §9.2. No minter is exposed because pass2
 * does not define canonical string encodings for `subjectKey` or `condition`.
 */
export interface NotificationIdentityTuple {
  readonly watchRuleId: WatchRuleId;
  readonly subjectKey: string;
  readonly condition: WatchCondition;
  readonly activityGeneration: ActivityGeneration;
  readonly episodeId?: DriftEpisodeId;
  readonly phase: 'condition' | 'drift-status-request' | 'drift-human-escalation';
}
