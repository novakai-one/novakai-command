// One builder for usage fixtures, shared by the deterministic suite and by
// tools/usage-preview.tsx.
//
// Shared on purpose, exactly as tests/fixtures/terminalTab.ts is: the totals
// line a human reads in a browser and the totals line the tests assert on must
// be built from the same rows, or the screenshots stop being evidence about the
// code the tests are guarding.
import type {
  RunUsageRowView, RunUsageValueView, UsageRowView, UsageTableView,
} from '../../contract/usage.js';

export const usageRow = (overrides: Partial<UsageRowView> = {}): UsageRowView => ({
  sessionId: 'sess_1',
  agentId: 'agent_kimi',
  provider: 'moonshot',
  model: 'kimi-k2-thinking',
  turns: 3,
  status: 'running',
  lastActivityAt: '2026-08-06T10:00:00.000Z',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cumulativeAdjusted: false,
  providerTotalInputTokens: null,
  interrupted: null,
  drift: false,
  note: 'measured',
  ...overrides,
});

export const usageTable = (rows: UsageRowView[]): UsageTableView => ({
  // eslint-disable-next-line id-length -- `at` is this view's published field name.
  at: '2026-08-06T10:05:00.000Z',
  rows,
  tokenAccounting: 'read from provider transcripts',
});

/** A value Supervision could not measure at all — the FZ-VIEW-010 case. */
export const unavailableValue: RunUsageValueView = {
  quality: 'unavailable',
  source: 'supervision',
  limitations: ['no canonical row'],
};

export const runUsageRow = (overrides: Partial<RunUsageRowView> = {}): RunUsageRowView => ({
  agentRunId: 'agentRun_019fd000-0000-7000-8000-0000000000a1',
  agentId: 'agent_kimi',
  displayName: 'Kimi',
  provider: 'moonshot',
  model: 'kimi-k2-thinking',
  lifecycle: 'running',
  inputTokens: unavailableValue,
  outputTokens: unavailableValue,
  cachedInputTokens: unavailableValue,
  costMicros: unavailableValue,
  providerTurns: unavailableValue,
  observedAt: '2026-08-06T10:00:00.000Z',
  final: false,
  ...overrides,
});
