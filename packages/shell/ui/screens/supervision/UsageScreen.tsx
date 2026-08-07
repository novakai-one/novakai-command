// shell/ui/screens/supervision/UsageScreen.tsx — the supervision usage table
// (§8, DEC-B1-11). Kit-composed ONLY (red gate 3 — tools/lint-kit.mjs).
//
// B1's single user-facing addition, and it obeys the house rules rather than
// bending them:
//
//   - Near-monochrome. No badge, chip or dot on a healthy row: a mark appears
//     ONLY on a session that has drifted or has an interrupted reply, so the
//     exception is the only thing that reads as one.
//   - The screen does not TELL Chris where to look. Order does that — drifting
//     first, then interrupted, then running, then closed.
//   - A count the server could not measure is an em dash, never a zero.
//
// The shell holds no usage truth: rows arrive on the server's `usage` WS event
// (broadcast every supervision.usageIntervalSec) and are shown as measured.
import React, { useEffect, useState } from 'react';
import type { ShellServices } from '../../../contract/index.js';
import {
  exceptionOf, formatIdentity, formatTokens, orderRows, totals, formatCount,
  describeTotalsScope,
  formatRunUsage, type RunUsageRowView, type RunUsageTableView,
  type UsageRowView, type UsageTableView,
} from '../../../contract/usage.js';
import { answerFrom } from '../../../contract/listAnswer.js';
import {
  EmptyState, ListRow, Panel, PresenceDot, ScrollArea, Stack, Text,
} from '../../kit/index.js';
import './usage.css';

/** Pure presentational — every value arrives as a prop, nothing is derived. */
export function UsageView(props: { table: UsageTableView | null }) {
  const table = props.table;
  // "Nobody has answered yet" is not "there are no sessions". This screen used
  // to print the second while meaning the first (contract/listAnswer.ts).
  const answer = answerFrom({
    source: table,
    failure: null,
    rowsOf: (answered: UsageTableView) => orderRows(answered.rows),
  });
  const rows = answer.kind === 'rows' ? answer.rows : [];
  const aggregate = totals(rows);

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Panel head="Sessions">
        <Stack className="nv-usage">
          {answer.kind === 'waiting' && <EmptyState>Reading sessions…</EmptyState>}
          {answer.kind === 'none' && <EmptyState>No provider sessions yet</EmptyState>}
          {answer.kind === 'rows' && (
            <Stack gap={0} className="nv-usage__rows">
              {rows.map((usageRow) => (
                <UsageRow key={usageRow.sessionId} row={usageRow} />
              ))}
            </Stack>
          )}
          {rows.length > 0 && (
            <Stack horizontal className="nv-usage__totals">
              {/* Derived, never asserted. "All sessions" was a literal here,
                  printed beside a sum that skipped the sessions nobody could
                  measure (FZ-VIEW-012: never a sum or a discard). */}
              <Text className="nv-usage__totalLabel">{describeTotalsScope(aggregate)}</Text>
              <Text className="nv-usage__totalValue">
                {`${formatCount(aggregate.input.value)} in · ${formatCount(aggregate.output.value)} out`}
              </Text>
            </Stack>
          )}
          {table && (
            // Provenance, not instruction: how the numbers were obtained, and
            // why a dash is a dash. Quiet, at the bottom, muted.
            <Text as="p" className="nv-usage__basis">{table.tokenAccounting}</Text>
          )}
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

/** B3d's per-Run usage surface; it only renders the Runtime view it receives. */
export function RunUsageView(props: { table: RunUsageTableView | null }) {
  const answer = answerFrom({
    source: props.table,
    failure: null,
    rowsOf: (answered: RunUsageTableView) => answered.rows,
  });
  return (
    <ScrollArea style={{ flex: 1 }}>
      <Panel head="Agent Runs">
        <Stack className="nv-usage">
          {answer.kind === 'waiting' && <EmptyState>Reading agent runs…</EmptyState>}
          {answer.kind === 'none' && <EmptyState>No agent runs yet</EmptyState>}
          {answer.kind === 'rows' && (
            <Stack gap={0} className="nv-usage__rows">
              {answer.rows.map((usageRow) => (
                <RunUsageRow key={usageRow.agentRunId} row={usageRow} />
              ))}
            </Stack>
          )}
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

/**
 * Found in a screenshot: this row used to put the run id AND all five metrics
 * into `meta` as one string joined with a `\n` that HTML does not honour. The
 * meta grew unbounded, squeezed the label to zero width — so the agent's NAME
 * vanished from its own row — and ran past the panel edge, cutting off cost and
 * turns. The values FZ-VIEW-010 insists on were on the page and not on screen.
 *
 * Same shape RunsScreen's row already uses: a titled row, then the facts under
 * it with room to wrap.
 */
function RunUsageRow(props: { row: RunUsageRowView }) {
  const usageRow = props.row;
  return (
    <Stack gap={0} className="nv-usage__run">
      <ListRow
        label={usageRow.displayName}
        meta={`${usageRow.provider} · ${usageRow.model} · ${usageRow.lifecycle}`}
      />
      <Text as="p" className="nv-usage__runId">{usageRow.agentRunId}</Text>
      <Text as="p" className="nv-usage__runValues">{formatRunUsage(usageRow)}</Text>
    </Stack>
  );
}

function UsageRow(props: { row: UsageRowView }) {
  const usageRow = props.row;
  const exception = exceptionOf(usageRow);
  return (
    <ListRow
      label={usageRow.agentId}
      meta={`${formatIdentity(usageRow)}  ·  ${formatTokens(usageRow)}`}
      // The ONLY ornament on this screen, and only when the row is the
      // exception. Liveness tokens, never the accent (R3-25).
      leading={exception ? (
        <PresenceDot
          state="offline"
          title={exception === 'drift'
            ? 'no answer to the last supervision check-in'
            : 'reply interrupted — resend to continue'}
        />
      ) : undefined}
    />
  );
}

export function UsageScreen(props: { services: ShellServices }) {
  const [table, setTable] = useState<UsageTableView | null>(null);
  const [runTable, setRunTable] = useState<RunUsageTableView | null>(null);

  useEffect(() => {
    let live = true;
    const reload = async (): Promise<void> => {
      if (props.services.getRunUsageTable) {
        try {
          const next = await props.services.getRunUsageTable();
          if (live) setRunTable(next);
          return;
        } catch {
          // An older host truthfully lacks B3 methods; its B1 table remains valid.
        }
      }
      const next = await props.services.getUsageTable?.();
      if (live && next !== undefined) setTable(next);
    };
    // One immediate pull so the screen is never blank waiting for an event.
    void reload();
    const unsubscribe = props.services.subscribe({
      onUsage: (next) => { if (live) setTable(next); },
      onRunUsageChanged: () => { void reload(); },
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [props.services]);

  if (!props.services.getRunUsageTable && !props.services.getUsageTable) {
    return <EmptyState>Supervision is not available in this host.</EmptyState>;
  }
  return runTable === null ? <UsageView table={table} /> : <RunUsageView table={runTable} />;
}
