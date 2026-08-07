// tools/runs-preview.tsx — a dev-only VISUAL proof of `RunsView`.
//
// Why it exists: the standing rule is that no UI is reported as done until it
// has been driven in a real browser. `RunsScreen` reads through the frozen door
// (FZ-VIEW-001), and no server composition yet serves both the Shell's boot
// methods and `b3.*` (tracer findings T-02/T-03) — so against a real host the
// Runs screen can only show its honest unavailable state. That state IS
// browse-verified, and so is the rail; but the ROWS would go to a seal unseen.
//
// This page closes that gap without faking a backed host. It mounts the real
// `RunsView` component with literal fixture props and the real stylesheet.
// There is no fake `ShellAgentServices`, no fake wire and no second
// composition — the tracer's law is intact, because a pure presentational
// component rendered with known props is not a composition of anything.
//
// It shares ONE fixture builder with the deterministic suite, so the rows a
// human looks at and the rows the tests assert on cannot drift apart.
//
// The banner is not decoration. Every screenshot taken here carries the words
// "FIXTURE DATA" so no capture from this page can ever be mistaken for
// evidence of backed rendering.
//
// Not in the shipped bundle: `vite build` builds `index.html`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RunsView } from '../ui/screens/agents/RunsScreen.js';
import type { AgentRunRowView, RunUsageValue } from '../contract/agentRuns.js';
import { runRow } from '../tests/fixtures/agentRunRow.js';

const measured = (value: number): RunUsageValue => ({
  quality: 'measured', value, source: 'agents', limitations: [],
});

// One row per state that has to read correctly, including the cases
// FZ-VIEW-034 names as places the two hosts could contradict each other.
const rows: AgentRunRowView[] = [
  runRow({
    id: 'agentRun_019fd39f-701b-7f3b-876f-0c4994e6beab', name: 'Lane B Builder',
    activity: 'working', childCount: 2, parentAgentId: 'agent_orchestrator',
    inputTokens: measured(48210), outputTokens: measured(11304),
  }),
  runRow({
    id: 'agentRun_019fd39f-778c-73c1-a0b5-22503b37c4de', name: 'Started in Terminal.app',
    activity: 'unknown', surface: 'external-terminal',
  }),
  runRow({
    id: 'agentRun_019fd3a0-0001-7000-8000-000000000003', name: 'Orphaned Auditor',
    uncertainty: ['provider-unreachable', 'usage-evidence-incomplete'],
    supervisor: { kind: 'orphaned', reason: 'supervisor-run-ended' },
  }),
  runRow({
    id: 'agentRun_019fd3a0-0001-7000-8000-000000000004', name: 'Finished Run',
    lifecycle: 'stopped', finalAt: '2026-08-06T03:11:00.000Z',
    finalReason: 'stopped-by-human',
  }),
];

const mount = document.getElementById('preview');
if (mount) {
  createRoot(mount).render(
    <React.StrictMode>
      <RunsView
        page={{ items: rows, omissions: [{ reason: 'permission', count: 1 }] }}
        error={null}
      />
    </React.StrictMode>,
  );
}
