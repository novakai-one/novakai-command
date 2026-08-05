// tools/usage-preview.tsx — a dev-only VISUAL proof of the usage surface.
//
// Why it exists: the standing rule is that no UI is reported as done until it
// has been driven in a real browser, and under the offline holdout harness the
// Sessions screen never reaches `UsageView` at all — the host has no
// supervision, so it draws "Supervision is not available in this host" and
// stops. That IS honest, and it is captured as evidence; but the totals line
// this slice changed would go to a seal unseen.
//
// This page closes that gap without faking a backed host: the real `UsageView`
// and `RunUsageView` over literal rows. No fake ShellServices, no socket, no
// second composition — a presentational component rendered with known props is
// not a composition of anything (the tracer's law).
//
// It shares ONE fixture builder with the deterministic suite
// (tests/fixtures/usageRow.ts), so the totals line a human reads here and the
// one the tests assert on are built from the same rows.
//
// Not in the shipped bundle: `vite build` builds `index.html`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { UsageView, RunUsageView } from '../ui/screens/supervision/UsageScreen.js';
import { Stack } from '../ui/kit/index.js';
import { runUsageRow, usageRow, usageTable } from '../tests/fixtures/usageRow.js';

// Three sessions, two of them measurable. The interesting row is the third:
// its counts are absent, so it must print dashes AND it must stop the totals
// line calling itself "All sessions" (FZ-VIEW-010/012).
const partial = usageTable([
  usageRow({ sessionId: 'sess_1', agentId: 'agent_kimi', inputTokens: 1_204, outputTokens: 88 }),
  usageRow({ sessionId: 'sess_2', agentId: 'agent_codex', inputTokens: 640, outputTokens: 51 }),
  usageRow({
    sessionId: 'sess_3',
    agentId: 'agent_fable',
    inputTokens: null,
    outputTokens: null,
    status: 'closed',
  }),
]);

// A Run Supervision could not measure at all. It still gets a row.
const runs = {
  // eslint-disable-next-line id-length -- `at` is this view's published field name.
  at: '2026-08-06T10:05:00.000Z',
  rows: [
    runUsageRow(),
    runUsageRow({
      agentRunId: 'agentRun_019fd000-0000-7000-8000-0000000000a2',
      agentId: 'agent_codex',
      displayName: 'Codex',
      lifecycle: 'completed',
      inputTokens: { quality: 'measured', value: 4_210, source: 'supervision', limitations: [] },
      outputTokens: { quality: 'measured', value: 302, source: 'supervision', limitations: [] },
    }),
  ],
};

function Preview(): React.JSX.Element {
  return (
    <Stack gap={0}>
      <UsageView table={partial} />
      <RunUsageView table={runs} />
    </Stack>
  );
}

createRoot(document.getElementById('preview')!).render(<Preview />);
