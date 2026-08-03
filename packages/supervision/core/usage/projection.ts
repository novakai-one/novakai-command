import { b3ok, type AgentRunId, type AuthenticatedPrincipal } from '@novakai/foundation/contract';
import type {
  AgentRunUsage,
  AgentUsageAggregate,
  AgentUsageSummary,
  ProviderUsageEvidence,
  SupervisionContract,
  UsageValue,
} from '../../contract/index.js';
import type { UsageEvidenceReader, UsageRunFacts, UsageRunReader } from './ports.js';

export type UsageProjection = Pick<SupervisionContract, 'getRunUsage' | 'getAgentUsage'>;

export interface UsageProjectionOptions {
  readonly runs: UsageRunReader;
  readonly evidence: UsageEvidenceReader;
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
    run: UsageRunFacts,
  ) => {
    const evidence = await options.evidence.listProviderUsageEvidence(
      principal,
      run.providerSessionId,
    );
    if (!evidence.ok) return evidence;
    return b3ok(projectRunUsage(
      run.agentRunId,
      run.final,
      evidence.value.items,
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
      for (const run of listed.value) {
        const projected = await project(principal, run);
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
  clock: () => Date,
): AgentRunUsage {
  const ordered = [...evidence].sort((left, right) =>
    String(left.observedAt).localeCompare(String(right.observedAt))
      || String(left.id).localeCompare(String(right.id)));
  const latest = ordered[ordered.length - 1];
  const unavailable = (): UsageValue => ({
    quality: 'unavailable',
    source: SOURCE,
    limitations: ['no-provider-usage-evidence'],
  });
  const metrics = Object.fromEntries(METRICS.map((metric) => [
    metric,
    latest === undefined ? unavailable() : usageValue(latest, metric),
  ])) as Pick<
    AgentRunUsage,
    typeof METRICS[number]
  >;
  return {
    agentRunId,
    ...metrics,
    observedAt: latest?.observedAt ?? clock().toISOString() as never,
    final,
  };
}

type UsageMetric = typeof METRICS[number];

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
    : runs.reduce((latest, run) => String(run.observedAt) > latest
      ? String(run.observedAt)
      : latest, String(runs[0]!.observedAt));
  return {
    ...metrics,
    observedAt: observedAt as never,
    final: runs.every((run) => run.final),
  };
}

function aggregateValue(
  runs: readonly AgentRunUsage[],
  metric: UsageMetric,
): UsageValue {
  if (runs.length === 0) {
    return { quality: 'unavailable', source: 'aggregate:runs', limitations: ['no-runs'] };
  }
  const supplied = runs.filter((run) => run[metric].value !== undefined);
  const limitations = [...new Set(runs.flatMap((run) => [
    ...run[metric].limitations,
    ...(run[metric].value === undefined ? [String(run.agentRunId)] : []),
  ]))].sort();
  if (supplied.length === 0) {
    return { quality: 'unavailable', source: 'aggregate:runs', limitations };
  }
  const everySupplies = supplied.length === runs.length;
  const hasPartialOrUnavailable = runs.some(
    (run) => run[metric].quality === 'partial' || run[metric].quality === 'unavailable',
  );
  const quality = runs.every((run) => run[metric].quality === 'measured')
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
      : { value: supplied.reduce((total, run) => total + run[metric].value!, 0) }),
    source: 'aggregate:runs',
    limitations,
  };
}
