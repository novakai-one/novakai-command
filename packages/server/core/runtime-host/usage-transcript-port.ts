import { b3err, b3fail, b3ok } from '@novakai/foundation/contract';
import type { GovernedAgentsContract } from '../../../agents/governed/contract/index.js';
import type { MessagingRuntimeApi, TranscriptLine } from '../../../messaging/contract/index.js';
import type {
  TranscriptUsageReader, TranscriptUsageSample,
} from '../../../supervision/public/index.js';

type UsageMessaging = Pick<
  MessagingRuntimeApi,
  'listProviderSessions' | 'listTranscriptLines'
>;

interface TranscriptUsagePortOptions {
  readonly agents: GovernedAgentsContract;
  readonly messaging: UsageMessaging;
  readonly clock?: () => Date;
}

const INPUT_KEYS = new Set([
  'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens',
]);
const OUTPUT_KEYS = new Set([
  'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens',
]);
const CACHE_KEYS = new Set([
  'cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens',
]);

function sumUsage(lines: readonly TranscriptLine[], keys: ReadonlySet<string>): number {
  return lines.reduce((total, line) => total + Object.entries(line.tokenUsage ?? {})
    .reduce((lineTotal, [key, value]) => keys.has(key) ? lineTotal + value : lineTotal, 0), 0);
}

function observedAt(lines: readonly TranscriptLine[], fallback: Date): string {
  return lines.reduce((latest, line) => {
    const candidate = line.providerOccurredAt ?? line.createdAt;
    return candidate > latest ? candidate : latest;
  }, '') || fallback.toISOString();
}

/** Translate committed Messaging roots into Supervision's read-only usage evidence. */
export function createTranscriptUsagePort(
  options: TranscriptUsagePortOptions,
): TranscriptUsageReader {
  const clock = options.clock ?? (() => new Date());
  return {
    async readTranscriptUsage(principal, runFacts) {
      const governed = await options.agents.getProviderSession(principal, runFacts.providerSessionId);
      if (!governed.ok) return governed;
      const resumeId = governed.value.providerResumeHandle
        ?? governed.value.providerConversationId;
      const sessions = await options.messaging.listProviderSessions();
      if (sessions.kind === 'error') return messagingFailure(sessions.error);
      const session = sessions.value.find((candidate) =>
        candidate.provider === governed.value.provider
        && resumeId !== null
        && candidate.resumeId === resumeId);
      if (session === undefined) return b3ok(unavailable(clock(), 'provider-session-not-ingested'));
      const listed = await options.messaging.listTranscriptLines({ sessionId: session.id });
      if (listed.kind === 'error') return messagingFailure(listed.error);
      const measured = listed.value.filter((line) => line.tokenUsage !== undefined);
      if (measured.length === 0) return b3ok(unavailable(clock(), 'no-committed-usage-lines'));
      const inputTokens = sumUsage(measured, INPUT_KEYS);
      const outputTokens = sumUsage(measured, OUTPUT_KEYS);
      const cachedInputTokens = sumUsage(measured, CACHE_KEYS);
      const complete = inputTokens > 0 && outputTokens > 0;
      return b3ok<TranscriptUsageSample>({
        quality: complete ? 'estimated' : 'partial',
        ...(inputTokens === 0 ? {} : { inputTokens }),
        ...(outputTokens === 0 ? {} : { outputTokens }),
        ...(cachedInputTokens === 0 ? {} : { cachedInputTokens }),
        observedAt: observedAt(measured, clock()) as never,
        source: `transcript-line:${session.id}`,
        limitations: ['provider-reported-usage', ...(complete ? [] : ['missing-token-category'])],
      });
    },
  };
}

function messagingFailure(error: Error & { readonly retryable: boolean; readonly name: string }) {
  return b3fail(b3err('RuntimeUnavailable', error.message, {
    owner: 'messaging', cause: error.name,
  }, error.retryable));
}

function unavailable(clock: Date, reason: string): TranscriptUsageSample {
  return {
    quality: 'unavailable',
    observedAt: clock.toISOString() as never,
    source: 'transcript-line:unavailable',
    limitations: [reason],
  };
}
