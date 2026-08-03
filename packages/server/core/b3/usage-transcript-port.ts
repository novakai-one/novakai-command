import { b3ok } from '@novakai/foundation/contract';
import type { GovernedAgentsContract } from '../../../agents/b3/contract/index.js';
import type {
  TranscriptUsageReader, TranscriptUsageSample,
} from '../../../supervision/public/index.js';
import type { UsageReader } from '../supervision/usage.js';

export interface TranscriptUsagePortOptions {
  readonly agents: GovernedAgentsContract;
  readonly reader: UsageReader;
  readonly clock?: () => Date;
}

/**
 * Resolve Runtime's provider-session pointer through Agents, then translate
 * the read-only provider transcript into Supervision evidence.
 */
export function createTranscriptUsagePort(
  options: TranscriptUsagePortOptions,
): TranscriptUsageReader {
  const clock = options.clock ?? (() => new Date());
  return {
    async readTranscriptUsage(principal, runFacts) {
      const session = await options.agents.getProviderSession(
        principal,
        runFacts.providerSessionId,
      );
      if (!session.ok) return session;
      const row = await options.reader.read({
        sessionId: String(runFacts.providerSessionId),
        provider: session.value.provider,
        providerConversationId: session.value.providerConversationId,
        // Native conversation ids are unique and the reader still confines
        // discovery to provider-owned roots; no launch-plan/cwd dependency is needed.
        cwd: '',
      });
      const allReportedTokensAreZero = row.basis === 'transcript'
        && row.inputTokens === 0
        && row.outputTokens === 0
        && row.cacheReadTokens === 0
        && row.cacheCreationTokens === 0;
      const quality: TranscriptUsageSample['quality'] = row.basis === 'unavailable'
        || allReportedTokensAreZero
        ? 'unavailable'
        : row.usagePartial ? 'partial' : 'estimated';
      const limitations = [
        row.note,
        ...(allReportedTokensAreZero ? ['transcript-contained-no-usage-measurement'] : []),
      ];
      return b3ok<TranscriptUsageSample>({
        quality,
        ...(quality === 'unavailable' || row.inputTokens === null
          ? {} : { inputTokens: row.inputTokens }),
        ...(quality === 'unavailable' || row.outputTokens === null
          ? {} : { outputTokens: row.outputTokens }),
        ...(quality === 'unavailable' || row.cacheReadTokens === null
          ? {} : { cachedInputTokens: row.cacheReadTokens }),
        observedAt: (row.lastActivityAt ?? clock().toISOString()) as never,
        source: row.source === null ? 'transcript:unavailable' : `transcript:${row.source}`,
        limitations,
      });
    },
  };
}
