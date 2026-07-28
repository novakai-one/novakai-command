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

/**
 * A count the server could not measure prints as an em dash. It must NEVER
 * print as 0: a zero says "this session cost nothing", which is a claim, and
 * the whole point of the null is that we do not have one.
 */
export function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US');
}

/** "codex · cli-default · 7 turns" — the quiet half of a row. */
export function formatIdentity(row: UsageRowView): string {
  return `${row.provider} · ${row.model} · ${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}`;
}

/** "1,204 in · 88 out" — or "— in · — out" when nothing is measurable. */
export function formatTokens(row: UsageRowView): string {
  return `${formatCount(row.inputTokens)} in · ${formatCount(row.outputTokens)} out`;
}

/**
 * Sort order: the rows that need Chris come first — drifting, then interrupted,
 * then running, then everything closed. Within a group, most recent first.
 *
 * Ordering is how this screen directs attention. It does not write a sentence
 * telling him where to look.
 */
export function orderRows(rows: readonly UsageRowView[]): UsageRowView[] {
  const rank = (row: UsageRowView): number => {
    if (row.drift) return 0;
    if (row.interrupted) return 1;
    if (row.status === 'running') return 2;
    return 3;
  };
  return [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}

/**
 * Does this row get a mark at all? Only the exception does. A dot on every row
 * is the pattern Chris rejected outright, so "healthy" is drawn as nothing.
 */
export function exceptionOf(row: UsageRowView): 'drift' | 'interrupted' | null {
  if (row.drift) return 'drift';
  if (row.interrupted) return 'interrupted';
  return null;
}

/** Totals across every session, skipping the counts that do not exist. */
export function totals(rows: readonly UsageRowView[]): { input: number | null; output: number | null } {
  const sum = (pick: (row: UsageRowView) => number | null): number | null => {
    const known = rows.map(pick).filter((v): v is number => v !== null);
    return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
  };
  return { input: sum((r) => r.inputTokens), output: sum((r) => r.outputTokens) };
}
