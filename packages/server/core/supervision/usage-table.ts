// packages/server/core/supervision/usage-table.ts — the per-session usage
// table, from real transcript data (DEC-B1-11; split from engine.ts, SUPFIX
// step 0).
import type { SessionUsage } from './usage.js';
import type {
  SupervisionEngine, SupervisionInternals, SupervisionRecord, UsageRow,
} from './types.js';

export function createUsageTable(internals: SupervisionInternals): {
  usageTable: SupervisionEngine['usageTable'];
  emitUsage: SupervisionEngine['emitUsage'];
} {
  const { deps, now, traced, reportFailure, driftFlags, usageRefOf } = internals;

  const rowFor = (record: SupervisionRecord, usage: SessionUsage): UsageRow => ({
    sessionId: record.sessionId,
    agentId: record.agentId,
    provider: record.provider,
    model: record.model,
    turns: record.turns,
    status: record.status,
    lastActivityAt: usage.lastActivityAt ?? record.lastActivityAt,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cumulativeAdjusted: usage.cumulativeAdjusted,
    usagePartial: usage.usagePartial,
    providerTotalInputTokens: usage.providerTotal?.inputTokens ?? null,
    source: usage.source,
    interrupted: record.lastInterruption?.clientOpId ?? null,
    drift: driftFlags.has(record.sessionId),
    note: usage.note,
  });

  const usageTable: SupervisionEngine['usageTable'] = async () => {
    const records = await deps.sessions.list();
    const usageBySession = await deps.usage.readMany(records.map(usageRefOf));
    const rows = records.map((record) => rowFor(record, usageBySession.get(record.sessionId)!));
    return {
      at: now(),
      rows,
      tokenAccounting:
        'read from provider transcripts: claude per-message (deduped by message id), '
        + 'kimi wire.jsonl step.end, codex rollout total_token_usage with a per-session '
        + 'baseline subtracted (its totals are cumulative). usagePartial=true means only '
        + 'provably attributable files were counted. null = no readable transcript.',
    };
  };

  const emitUsage: SupervisionEngine['emitUsage'] = async () => {
    const table = await usageTable();
    for (const row of table.rows) {
      const backfilled = row.inputTokens !== null
        && row.outputTokens !== null
        && row.cacheReadTokens !== null
        && row.cacheCreationTokens !== null
        && row.source
        ? await deps.sessions.recordUsage(row.sessionId, {
          kind: 'measured',
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
          source: row.source,
          measuredAt: row.lastActivityAt,
          ...(row.usagePartial ? { usagePartial: true as const } : {}),
        })
        : await deps.sessions.recordUsage(row.sessionId, {
          kind: 'unavailable',
          reason: row.note,
          checkedAt: table.at,
        });
      if (!backfilled.ok) {
        reportFailure(
          'UsageBackfillFailed',
          'backfillUsage',
          backfilled.error ?? `providerSession usage backfill failed for ${row.sessionId}`,
        );
      }
    }
    try {
      await deps.appendUsage(table.rows);
    } catch (cause) {
      reportFailure('UsageAppendFailed', 'appendUsage', cause);
    }
    try {
      await deps.broadcast('usage', table);
    } catch (cause) {
      reportFailure('UsageBroadcastFailed', 'broadcastUsage', cause);
    }
    await traced('supervision.usage', 'all', { sessions: table.rows.length });
    return table;
  };

  return { usageTable, emitUsage };
}
