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
  type UsageRowView, type UsageTableView,
} from '../../../contract/usage.js';
import {
  EmptyState, ListRow, Panel, PresenceDot, ScrollArea, Stack, Text,
} from '../../kit/index.js';
import './usage.css';

/** Pure presentational — every value arrives as a prop, nothing is derived. */
export function UsageView(props: { table: UsageTableView | null }) {
  const table = props.table;
  const rows = orderRows(table?.rows ?? []);
  const sum = totals(rows);

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Panel head="Sessions">
        <Stack className="nv-usage">
          {rows.length === 0 ? (
            <EmptyState>No provider sessions yet</EmptyState>
          ) : (
            <Stack gap={0} className="nv-usage__rows">
              {rows.map((row) => (
                <UsageRow key={row.sessionId} row={row} />
              ))}
            </Stack>
          )}
          {rows.length > 0 && (
            <Stack horizontal className="nv-usage__totals">
              <Text className="nv-usage__totalLabel">All sessions</Text>
              <Text className="nv-usage__totalValue">
                {`${formatCount(sum.input)} in · ${formatCount(sum.output)} out`}
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

function UsageRow(props: { row: UsageRowView }) {
  const { row } = props;
  const exception = exceptionOf(row);
  return (
    <ListRow
      label={row.agentId}
      meta={`${formatIdentity(row)}  ·  ${formatTokens(row)}`}
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

  useEffect(() => {
    let live = true;
    // One immediate pull so the screen is never blank waiting for the interval,
    // then the broadcast keeps it current.
    void props.services.getUsageTable?.().then((next) => { if (live) setTable(next); });
    const off = props.services.subscribe({
      onUsage: (next) => { if (live) setTable(next); },
    });
    return () => { live = false; off(); };
  }, [props.services]);

  if (!props.services.getUsageTable) {
    return <EmptyState>Supervision is not available in this host.</EmptyState>;
  }
  return <UsageView table={table} />;
}
