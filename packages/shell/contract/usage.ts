// packages/shell/contract/usage.ts — the supervision usage surface (§8).
//
// This is B1's ONE user-facing addition, and it exists because Chris asked for
// it by name: "usage table output every 5–10 min for Chris". Everything here is
// presentation of numbers the server measured — the shell computes no token
// counts, keeps no usage truth, and invents nothing when a count is missing.
//
// The formatting lives here rather than in the component so the rules a screen
// cannot show wrongly — "null is a dash, never a zero", "one attention row" —
// are testable without a DOM.

/** One row as the server's `usage` event delivers it. */
export interface UsageRowView {
  sessionId: string;
  agentId: string;
  provider: string;
  model: string;
  turns: number;
  status: string;
  lastActivityAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cumulativeAdjusted: boolean;
  providerTotalInputTokens: number | null;
  interrupted: string | null;
  drift: boolean;
  note: string;
}

export interface UsageTableView {
  at: string;
  rows: UsageRowView[];
  tokenAccounting: string;
}

export type RunUsageQuality = 'measured' | 'estimated' | 'partial' | 'unavailable';

/** Browser-safe copy of one sourced Supervision usage value. */
export interface RunUsageValueView {
  quality: RunUsageQuality;
  value?: number;
  source: string;
  limitations: readonly string[];
}

/** One Runtime Run with the exact Supervision usage row embedded in its view. */
export interface RunUsageRowView {
  agentRunId: string;
  agentId: string;
  displayName: string;
  provider: string;
  model: string;
  lifecycle: string;
  inputTokens: RunUsageValueView;
  outputTokens: RunUsageValueView;
  cachedInputTokens: RunUsageValueView;
  costMicros: RunUsageValueView;
  providerTurns: RunUsageValueView;
  observedAt: string;
  final: boolean;
}

export interface RunUsageTableView {
  at: string;
  rows: readonly RunUsageRowView[];
}

/**
 * A count the server could not measure prints as an em dash. It must NEVER
 * print as 0: a zero says "this session cost nothing", which is a claim, and
 * the whole point of the null is that we do not have one.
 */
export function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US');
}

/** "codex · cli-default · 7 turns" — the quiet half of a row. */
export function formatIdentity(usageRow: UsageRowView): string {
  return `${usageRow.provider} · ${usageRow.model} · ${usageRow.turns} `
    + `${usageRow.turns === 1 ? 'turn' : 'turns'}`;
}

/** "1,204 in · 88 out" — or "— in · — out" when nothing is measurable. */
export function formatTokens(usageRow: UsageRowView): string {
  return `${formatCount(usageRow.inputTokens)} in · `
    + `${formatCount(usageRow.outputTokens)} out`;
}

function formatRunMetric(value: RunUsageValueView, label: string): string {
  const limitations = value.limitations.length === 0
    ? '' : `: ${value.limitations.join(', ')}`;
  return `${formatCount(value.value ?? null)} ${label} (${value.quality}${limitations})`;
}

/** Quality and limitation stay beside every B3d value; absence remains a dash. */
export function formatRunUsage(usageRow: RunUsageRowView): string {
  return [
    formatRunMetric(usageRow.inputTokens, 'in'),
    formatRunMetric(usageRow.outputTokens, 'out'),
    formatRunMetric(usageRow.cachedInputTokens, 'cached'),
    formatRunMetric(usageRow.costMicros, 'µ-cost'),
    formatRunMetric(usageRow.providerTurns, 'turns'),
  ].join(' · ');
}

/**
 * Sort order: the rows that need Chris come first — drifting, then interrupted,
 * then running, then everything closed. Within a group, most recent first.
 *
 * Ordering is how this screen directs attention. It does not write a sentence
 * telling him where to look.
 */
export function orderRows(rows: readonly UsageRowView[]): UsageRowView[] {
  const rank = (usageRow: UsageRowView): number => {
    if (usageRow.drift) return 0;
    if (usageRow.interrupted) return 1;
    if (usageRow.status === 'running') return 2;
    return 3;
  };
  return [...rows].sort((firstRow, secondRow) => {
    const byRank = rank(firstRow) - rank(secondRow);
    if (byRank !== 0) return byRank;
    return Date.parse(secondRow.lastActivityAt) - Date.parse(firstRow.lastActivityAt);
  });
}

/**
 * Does this row get a mark at all? Only the exception does. A dot on every row
 * is the pattern Chris rejected outright, so "healthy" is drawn as nothing.
 */
export function exceptionOf(usageRow: UsageRowView): 'drift' | 'interrupted' | null {
  if (usageRow.drift) return 'drift';
  if (usageRow.interrupted) return 'interrupted';
  return null;
}

/** Totals across every session, skipping the counts that do not exist. */
export function totals(rows: readonly UsageRowView[]): { input: number | null; output: number | null } {
  const aggregateKnown = (pick: (usageRow: UsageRowView) => number | null): number | null => {
    const known = rows.map(pick).filter((value): value is number => value !== null);
    return known.length === 0
      ? null
      : known.reduce((total, nextValue) => total + nextValue, 0);
  };
  return {
    input: aggregateKnown((usageRow) => usageRow.inputTokens),
    output: aggregateKnown((usageRow) => usageRow.outputTokens),
  };
}
