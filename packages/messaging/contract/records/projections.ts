import type { ProviderSessionId, TranscriptLineId } from '../types.js';

/** Rebuildable non-negative token totals for one provider session. */
export interface UsageRollup {
  readonly sessionId: ProviderSessionId;
  readonly tokens: number;
}

/** Rebuildable lookup for one tool-bearing TranscriptLine. */
export interface ToolCallIndex {
  readonly transcriptLineId: TranscriptLineId;
  readonly toolName: string;
}

/** Complete deterministic result of one projection replacement. */
export interface ProjectionRebuildResult {
  readonly usageRollups: readonly UsageRollup[];
  readonly toolCalls: readonly ToolCallIndex[];
}
