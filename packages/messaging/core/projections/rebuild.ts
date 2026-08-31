import type {
  ProjectionRebuildResult,
  ToolCallIndex,
} from '../../contract/records/projections.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { ProviderSessionId } from '../../contract/types.js';
import { compareStrings } from '../compare.js';

/**
 * Recomputes every rebuildable projection from the ordered transcript lines:
 * per-session token rollups and the tool-call index. Projections carry no
 * authority of their own — they can be dropped and rebuilt from the lines at
 * any time, so this function is deterministic and pure. Crash safety is owned
 * by the caller: the runtime wraps this in the store's `replaceProjections`,
 * so a crash before that call leaves the previous projection intact.
 *
 * Ordering is code-unit based, never locale-dependent, so the same lines
 * produce byte-identical output on any host.
 */
export function rebuildProjections(
  lines: readonly TranscriptLine[],
): ProjectionRebuildResult {
  const tokensBySession = new Map<ProviderSessionId, number>();
  const toolCalls: ToolCallIndex[] = [];
  for (const line of lines) {
    accrueTokens(tokensBySession, line);
    const name = toolName(line);
    if (name !== undefined) toolCalls.push({ transcriptLineId: line.id, toolName: name });
  }
  return {
    usageRollups: sortedRollups(tokensBySession),
    toolCalls: sortedToolCalls(toolCalls),
  };
}

/** Adds one line's token usage to its session's running total. */
function accrueTokens(
  tokensBySession: Map<ProviderSessionId, number>,
  line: TranscriptLine,
): void {
  const running = tokensBySession.get(line.sessionId) ?? 0;
  tokensBySession.set(line.sessionId, running + tokenTotal(line));
}

/**
 * Sums a line's reported token usage, ignoring malformed entries. Totals are
 * exact while one session's lifetime usage stays below
 * Number.MAX_SAFE_INTEGER (~9 quadrillion tokens); beyond that the contract's
 * non-negative guarantee holds but precision does not.
 */
function tokenTotal(line: TranscriptLine): number {
  let total = 0;
  for (const value of Object.values(line.tokenUsage ?? {})) {
    if (isValidTokenCount(value)) total += value;
  }
  return total;
}

/** A token count is usable only as a non-negative safe integer. */
const isValidTokenCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * Best-effort tool name from a line's provider-specific tool-call payload;
 * 'unknown' when the line is a tool call whose payload names nothing.
 */
function toolName(line: TranscriptLine): string | undefined {
  if (line.toolCall === undefined) return undefined;
  const declared = declaredToolName(line.toolCall);
  if (declared !== undefined) return declared;
  if (line.role === 'tool_call') return 'unknown';
  return undefined;
}

/** The payload keys providers have used to name a tool call, in preference order. */
const TOOL_NAME_KEYS = ['name', 'toolName', 'tool_name'] as const;

/** The first non-empty tool name a provider payload declares, if any. */
function declaredToolName(call: Readonly<Record<string, unknown>>): string | undefined {
  for (const nameKey of TOOL_NAME_KEYS) {
    const value = call[nameKey];
    if (isNonEmptyString(value)) return value;
  }
  return undefined;
}

/** True only for a string with real content. */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** Rollups in session-id order, so reruns produce byte-identical output. */
function sortedRollups(
  tokensBySession: ReadonlyMap<ProviderSessionId, number>,
): ProjectionRebuildResult['usageRollups'] {
  return [...tokensBySession.entries()]
    .map(([sessionId, tokens]) => ({ sessionId, tokens }))
    .sort((left, right) => compareStrings(left.sessionId, right.sessionId));
}

/** Tool calls in line-id order (not transcript position), so reruns produce byte-identical output. */
function sortedToolCalls(toolCalls: readonly ToolCallIndex[]): readonly ToolCallIndex[] {
  return [...toolCalls].sort((left, right) =>
    compareStrings(left.transcriptLineId, right.transcriptLineId));
}
