import { b3ok, type AgentRunId, type AuthenticatedPrincipal } from '@novakai/foundation/contract';
import type {
  AgentRunUsage,
  AgentUsageAggregate,
  AgentUsageSummary,
  ProviderUsageEvidence,
  SupervisionContract,
  UsageValue,
} from '../../contract/index.js';
import type {
  TranscriptUsageReader,
  TranscriptUsageSample,
  UsageEvidenceReader,
  UsageRunFacts,
  UsageRunReader,
} from './ports.js';

export type UsageProjection = Pick<SupervisionContract, 'getRunUsage' | 'getAgentUsage'>;

export interface UsageProjectionOptions {
  readonly runs: UsageRunReader;
  readonly evidence: UsageEvidenceReader;
  readonly transcript?: TranscriptUsageReader;
  readonly clock?: () => Date;
}

const SOURCE = 'agents:provider-usage-evidence';
const METRICS = [
  'inputTokens', 'outputTokens', 'cachedInputTokens', 'costMicros', 'providerTurns',
] as const;

/** Rebuild usage on demand from Runtime Run facts plus Agents evidence. */
export function createUsageProjection(options: UsageProjectionOptions): UsageProjection {
  const clock = options.clock ?? (() => new Date());
  const project = async (
    principal: AuthenticatedPrincipal,
    runFacts: UsageRunFacts,
  ) => {
    const evidence = await options.evidence.listProviderUsageEvidence(
      principal,
      runFacts.providerSessionId,
    );
    if (!evidence.ok) return evidence;
    const latest = latestEvidence(evidence.value.items);
    const needsTranscript = latest === undefined
      || latest.measurement.quality === 'unavailable'
      || latest.measurement.inputTokens === undefined
      || latest.measurement.outputTokens === undefined
      || latest.measurement.cachedInputTokens === undefined;
    const transcript = needsTranscript
      ? await options.transcript?.readTranscriptUsage(principal, runFacts)
      : undefined;
    if (transcript !== undefined && !transcript.ok) return transcript;
    return b3ok(projectRunUsage(
      runFacts.agentRunId,
      runFacts.final,
      evidence.value.items,
      transcript?.value,
      clock,
    ));
  };
  return {
    async getRunUsage(principal, agentRunId) {
      const run = await options.runs.getUsageRun(principal, agentRunId);
      if (!run.ok) return run;
      return project(principal, run.value);
    },
    async getAgentUsage(principal, agentId) {
      const listed = await options.runs.listUsageRuns(principal, agentId);
      if (!listed.ok) return listed;
      const runs: AgentRunUsage[] = [];
      for (const runFacts of listed.value) {
        const projected = await project(principal, runFacts);
        if (!projected.ok) return projected;
        runs.push(projected.value);
      }
      runs.sort((left, right) => String(left.agentRunId).localeCompare(String(right.agentRunId)));
      return b3ok<AgentUsageSummary>({
        agentId,
        runs,
        aggregate: aggregateUsage(runs, clock),
      });
    },
  };
}

function projectRunUsage(
  agentRunId: AgentRunId,
  final: boolean,
  evidence: readonly ProviderUsageEvidence[],
  transcript: TranscriptUsageSample | undefined,
  clock: () => Date,
): AgentRunUsage {
  const latest = latestEvidence(evidence);
  const availableTranscript = transcript?.quality === 'unavailable' ? undefined : transcript;
  const unavailable = (): UsageValue => ({
    quality: 'unavailable',
    source: availableTranscript?.source ?? SOURCE,
    limitations: availableTranscript?.limitations ?? ['no-provider-usage-evidence'],
  });
  const metrics = Object.fromEntries(METRICS.map((metric) => [
    metric,
    latest === undefined
      ? transcriptUsageValue(transcript, metric) ?? unavailable()
      : preferEvidence(latest, transcript, metric),
  ])) as Pick<
    AgentRunUsage,
    typeof METRICS[number]
  >;
  return {
    agentRunId,
    ...metrics,
    observedAt: newestObservedAt(latest?.observedAt, availableTranscript?.observedAt)
      ?? clock().toISOString() as never,
    final,
  };
}

type UsageMetric = typeof METRICS[number];

function latestEvidence(
  evidence: readonly ProviderUsageEvidence[],
): ProviderUsageEvidence | undefined {
  return [...evidence].sort((left, right) =>
    String(left.observedAt).localeCompare(String(right.observedAt))
      || String(left.id).localeCompare(String(right.id)))[evidence.length - 1];
}

function newestObservedAt(
  evidenceAt: ProviderUsageEvidence['observedAt'] | undefined,
  transcriptAt: TranscriptUsageSample['observedAt'] | undefined,
): ProviderUsageEvidence['observedAt'] | undefined {
  if (evidenceAt === undefined) return transcriptAt;
  if (transcriptAt === undefined) return evidenceAt;
  return String(evidenceAt) >= String(transcriptAt) ? evidenceAt : transcriptAt;
}

function preferEvidence(
  evidence: ProviderUsageEvidence,
  transcript: TranscriptUsageSample | undefined,
  metric: UsageMetric,
): UsageValue {
  const preferred = usageValue(evidence, metric);
  return preferred.value !== undefined
    ? preferred
    : transcriptUsageValue(transcript, metric) ?? preferred;
}

function transcriptUsageValue(
  transcript: TranscriptUsageSample | undefined,
  metric: UsageMetric,
): UsageValue | undefined {
  if (transcript === undefined || transcript.quality === 'unavailable') return undefined;
  const value = metric === 'inputTokens'
    ? transcript.inputTokens
    : metric === 'outputTokens'
      ? transcript.outputTokens
      : metric === 'cachedInputTokens'
        ? transcript.cachedInputTokens
        : undefined;
  if (value === undefined) {
    return {
      quality: 'unavailable',
      source: transcript.source,
      limitations: [...transcript.limitations, `${metric}-not-reported`],
    };
  }
  return {
    quality: transcript.quality,
    value,
    source: transcript.source,
    limitations: transcript.limitations,
  };
}

function usageValue(
  evidence: ProviderUsageEvidence,
  metric: UsageMetric,
): UsageValue {
  const value = evidence.measurement[metric];
  if (value === undefined || evidence.measurement.quality === 'unavailable') {
    return {
      quality: 'unavailable',
      source: evidence.source,
      limitations: [...evidence.measurement.limitations, `${metric}-not-reported`],
    };
  }
  return {
    quality: evidence.measurement.quality,
    value,
    source: evidence.source,
    limitations: evidence.measurement.limitations,
  };
}

function aggregateUsage(
  runs: readonly AgentRunUsage[],
  clock: () => Date,
): AgentUsageAggregate {
  const metrics = Object.fromEntries(METRICS.map((metric) => [
    metric,
    aggregateValue(runs, metric),
  ])) as Pick<AgentUsageAggregate, UsageMetric>;
  const observedAt = runs.length === 0
    ? clock().toISOString()
    : runs.reduce((latest, runUsage) => String(runUsage.observedAt) > latest
      ? String(runUsage.observedAt)
      : latest, String(runs[0]!.observedAt));
  return {
    ...metrics,
    observedAt: observedAt as never,
    final: runs.every((runUsage) => runUsage.final),
  };
}

function aggregateValue(
  runs: readonly AgentRunUsage[],
  metric: UsageMetric,
): UsageValue {
  if (runs.length === 0) {
    return { quality: 'unavailable', source: 'aggregate:runs', limitations: ['no-runs'] };
  }
  const supplied = runs.filter((runUsage) => runUsage[metric].value !== undefined);
  const limitations = [...new Set(runs.flatMap((runUsage) => [
    ...runUsage[metric].limitations,
    ...(runUsage[metric].value === undefined ? [String(runUsage.agentRunId)] : []),
  ]))].sort();
  if (supplied.length === 0) {
    return { quality: 'unavailable', source: 'aggregate:runs', limitations };
  }
  const everySupplies = supplied.length === runs.length;
  const hasPartialOrUnavailable = runs.some(
    (runUsage) => runUsage[metric].quality === 'partial'
      || runUsage[metric].quality === 'unavailable',
  );
  const quality = runs.every((runUsage) => runUsage[metric].quality === 'measured')
    ? 'measured'
    : everySupplies && !hasPartialOrUnavailable
      ? 'estimated'
      : hasPartialOrUnavailable
        ? 'partial'
        : 'unavailable';
  return {
    quality,
    ...(quality === 'unavailable'
      ? {}
      : { value: supplied.reduce(
          (total, runUsage) => total + runUsage[metric].value!, 0,
        ) }),
    source: 'aggregate:runs',
    limitations,
  };
}
