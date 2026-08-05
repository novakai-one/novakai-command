// One `AgentRunRowView` fixture, shared by every Runs-view test.
//
// It exists so the two suites that render this projection cannot drift apart
// from each other while both stay green — the same failure shape, one level
// down, that FZ-VIEW-034 exists to stop between the Shell and the CLI.
import type { AgentRunRowView, AgentRunsPageView, RunUsageValue }
  from '../../contract/agentRuns.js';

export const unavailable: RunUsageValue = {
  quality: 'unavailable', source: 'agents', limitations: [],
};

export interface RunRowOverrides {
  readonly id?: string;
  /** A tree needs distinct agents; every other suite is happy with the default. */
  readonly agentId?: string;
  readonly name?: string;
  readonly lifecycle?: string;
  readonly activity?: string;
  readonly surface?: string;
  readonly startedAt?: string;
  readonly finalAt?: string;
  readonly finalReason?: string;
  readonly uncertainty?: readonly string[];
  readonly inputTokens?: RunUsageValue;
  readonly outputTokens?: RunUsageValue;
  readonly parentAgentId?: string;
  readonly childCount?: number;
  readonly supervisor?: AgentRunRowView['family']['supervisor'];
}

export function runRow(partial: RunRowOverrides = {}): AgentRunRowView {
  const id = partial.id ?? 'agentRun_1';
  const agentId = partial.agentId ?? 'agent_1';
  return {
    agent: {
      agentId, displayName: partial.name ?? 'Builder',
      roleProfileId: 'agentRole_1',
    },
    // `run` is frozen contract text (FZ-VIEW-002) — the same named waiver
    // `contract/agentRuns.ts` already carries. A fixture that renamed it would
    // stop matching the wire, which is the one thing a fixture must not do.
    // eslint-disable-next-line id-length -- frozen field name, see above
    run: {
      id, kind: 'agentRun', schemaVersion: 1, recordVersion: 3,
      createdAt: '2026-08-06T01:00:00.000Z', permissionLevel: 'private',
      createdBy: 'person_chris', lastMutation: { state: 'trace-complete' },
      agentId, launchPlanId: 'launchPlan_1', providerSessionId: 'sess_1',
      lifecycle: partial.lifecycle ?? 'ready', activity: partial.activity ?? 'idle',
      activityGeneration: 1, launchSurface: partial.surface ?? 'novakai-shell',
      requestedBy: 'person_chris', rootTraceId: 'trace_1',
      uncertainty: partial.uncertainty ?? [],
      ...(partial.startedAt === undefined ? {} : { startedAt: partial.startedAt }),
      ...(partial.finalAt === undefined ? {} : { finalAt: partial.finalAt }),
      ...(partial.finalReason === undefined ? {} : { finalReason: partial.finalReason }),
    },
    provider: {
      provider: 'claude', modelId: 'opus', effort: 'default', providerSessionId: 'sess_1',
    },
    launch: {
      surface: partial.surface ?? 'novakai-shell', requestedBy: 'person_chris',
      ...(partial.startedAt === undefined ? {} : { startedAt: partial.startedAt }),
    },
    family: {
      childCount: partial.childCount ?? 0,
      supervisor: partial.supervisor ?? { kind: 'human', principalId: 'person_chris' },
      supervisionVersion: 1,
      ...(partial.parentAgentId === undefined ? {} : { parentAgentId: partial.parentAgentId }),
    },
    usage: {
      agentRunId: id,
      inputTokens: partial.inputTokens ?? unavailable,
      outputTokens: partial.outputTokens ?? unavailable,
      cachedInputTokens: unavailable, costMicros: unavailable, providerTurns: unavailable,
      observedAt: '2026-08-06T01:00:05.000Z', final: false,
    },
    transcript: { bindingState: 'waiting' },
  };
}

export const pageOf = (
  items: readonly AgentRunRowView[], omitted = 0,
): AgentRunsPageView => ({
  items,
  omissions: omitted === 0 ? [] : [{ reason: 'permission', count: omitted }],
});
