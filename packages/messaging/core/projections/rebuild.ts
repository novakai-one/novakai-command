import type {
  ProjectionRebuildResult,
  ToolCallIndex,
} from '../../contract/records/projections.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { ProviderSessionId } from '../../contract/types.js';

/**
 * Recomputes every rebuildable projection from the ordered transcript lines:
 * per-session token rollups and the tool-call index. Projections carry no
 * authority of their own — they can be dropped and rebuilt from the lines at
 * any time, so this function is deterministic, pure, and safe to rerun after
 * any crash.
 */
export function rebuildProjections(
  lines: readonly TranscriptLine[],
): ProjectionRebuildResult {
  const totals = new Map<string, number>();
  const toolCalls: ToolCallIndex[] = [];
  for (const line of lines) {
    totals.set(line.sessionId, (totals.get(line.sessionId) ?? 0) + tokenTotal(line));
    const name = toolName(line);
    if (name !== undefined) toolCalls.push({ transcriptLineId: line.id, toolName: name });
  }
  const usageRollups = [...totals.entries()]
    .map(([sessionId, tokens]) => ({ sessionId: sessionId as ProviderSessionId, tokens }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  toolCalls.sort((left, right) => left.transcriptLineId.localeCompare(right.transcriptLineId));
  return { usageRollups, toolCalls };
}

/** Sums a line's reported token usage, ignoring malformed entries. */
function tokenTotal(line: TranscriptLine): number {
  return Object.values(line.tokenUsage ?? {}).reduce((sum, value) =>
    Number.isSafeInteger(value) && value >= 0 ? sum + value : sum, 0);
}

/**
 * Best-effort tool name from a line's provider-specific tool-call payload;
 * 'unknown' when the line is a tool call whose payload names nothing.
 */
function toolName(line: TranscriptLine): string | undefined {
  const call = line.toolCall;
  if (call === undefined) return undefined;
  for (const key of ['name', 'toolName', 'tool_name']) {
    const value = call[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return line.role === 'tool_call' ? 'unknown' : undefined;
}
