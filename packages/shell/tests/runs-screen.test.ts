// B3e tracer — the one Shell view that renders a Run (FZ-VIEW-002/003).
//
// It renders the SAME projection `nvk agent list --json` prints, so the rules
// tested here are the ones a screen can break without breaking a wire:
// launch origin is history, lifecycle is not activity, and an unavailable
// measurement is never drawn as a number.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  describeLaunchOrigin, describeRunState, describeRunUsage, orderRuns,
  type AgentRunRowView, type AgentRunsPageView,
} from '../contract/agentRuns.js';
import { RunsView } from '../ui/screens/agents/RunsScreen.js';

const unavailable = { quality: 'unavailable', source: 'agents', limitations: [] } as const;

function runRow(partial: {
  id?: string; name?: string; lifecycle?: string; activity?: string;
  surface?: string; startedAt?: string; uncertainty?: readonly string[];
  outputTokens?: AgentRunRowView['usage']['outputTokens'];
} = {}): AgentRunRowView {
  return {
    agent: {
      agentId: 'agent_1', displayName: partial.name ?? 'Builder',
      roleProfileId: 'agentRole_1',
    },
    run: {
      id: partial.id ?? 'agentRun_1', kind: 'agentRun', schemaVersion: 1, recordVersion: 3,
      createdAt: '2026-08-06T01:00:00.000Z', permissionLevel: 'private',
      createdBy: 'person_chris', lastMutation: { state: 'trace-complete' },
      agentId: 'agent_1', launchPlanId: 'launchPlan_1', providerSessionId: 'sess_1',
      lifecycle: partial.lifecycle ?? 'ready', activity: partial.activity ?? 'idle',
      activityGeneration: 1, launchSurface: partial.surface ?? 'novakai-shell',
      requestedBy: 'person_chris', rootTraceId: 'trace_1',
      uncertainty: partial.uncertainty ?? [],
      ...(partial.startedAt === undefined ? {} : { startedAt: partial.startedAt }),
    },
    provider: {
      provider: 'claude', modelId: 'opus', effort: 'default', providerSessionId: 'sess_1',
    },
    launch: {
      surface: partial.surface ?? 'novakai-shell', requestedBy: 'person_chris',
      ...(partial.startedAt === undefined ? {} : { startedAt: partial.startedAt }),
    },
    family: {
      childCount: 0, supervisor: { kind: 'human', principalId: 'person_chris' },
      supervisionVersion: 1,
    },
    usage: {
      agentRunId: partial.id ?? 'agentRun_1',
      inputTokens: unavailable,
      outputTokens: partial.outputTokens ?? unavailable,
      cachedInputTokens: unavailable, costMicros: unavailable, providerTurns: unavailable,
      observedAt: '2026-08-06T01:00:05.000Z', final: false,
    },
    transcript: { bindingState: 'waiting' },
  };
}

const pageOf = (items: AgentRunRowView[], omitted = 0): AgentRunsPageView => ({
  items,
  omissions: omitted === 0 ? [] : [{ reason: 'permission', count: omitted }],
});

describe('launch origin is history, never inferred (FZ-VIEW-004)', () => {
  it('says where the Run was STARTED, not where it is attached now', () => {
    expect(describeLaunchOrigin(runRow({ surface: 'external-terminal' })))
      .toContain('Terminal');
    expect(describeLaunchOrigin(runRow({ surface: 'novakai-shell' })))
      .toContain('Novakai');
  });

  it('a stopped Run still reports the surface it was started from', () => {
    const stopped = runRow({ surface: 'script', lifecycle: 'stopped' });
    expect(describeLaunchOrigin(stopped)).toContain('script');
  });
});

describe('lifecycle is not activity (FZ-VIEW-006)', () => {
  it('draws both, as separate facts', () => {
    const state = describeRunState(runRow({ lifecycle: 'ready', activity: 'working' }));
    expect(state).toContain('ready');
    expect(state).toContain('working');
  });

  it('activity "unknown" is a state that gets DRAWN, not a blank', () => {
    const state = describeRunState(runRow({ lifecycle: 'ready', activity: 'unknown' }));
    expect(state).toContain('unknown');
    // And it must not be reported as stopped: not knowing is not finality.
    expect(state).not.toContain('stopped');
  });
});

describe('an unavailable measurement is never a zero (FZ-VIEW-010)', () => {
  it('prints a dash and keeps the quality word beside it', () => {
    const text = describeRunUsage(runRow());
    expect(text).toContain('—');
    expect(text).toContain('unavailable');
    expect(text).not.toMatch(/\b0\b/u);
  });

  it('prints a measured value when there is one', () => {
    const measured = { quality: 'measured', value: 1204, source: 'agents', limitations: [] };
    expect(describeRunUsage(runRow({ outputTokens: measured }))).toContain('1,204');
  });
});

describe('ordering directs attention; the screen never writes a sentence about it', () => {
  it('a Run carrying uncertainty sorts above a quiet one', () => {
    const quiet = runRow({ id: 'agentRun_quiet' });
    const uncertain = runRow({ id: 'agentRun_uncertain', uncertainty: ['provider-unreachable'] });
    expect(orderRuns([quiet, uncertain])[0]?.run.id).toBe('agentRun_uncertain');
  });

  it('working sorts above idle', () => {
    const idle = runRow({ id: 'agentRun_idle', activity: 'idle' });
    const working = runRow({ id: 'agentRun_working', activity: 'working' });
    expect(orderRuns([idle, working])[0]?.run.id).toBe('agentRun_working');
  });
});

describe('the screen tells the truth about what it could not show', () => {
  it('renders omitted rows as a visible count, never silently', () => {
    const html = renderToStaticMarkup(
      React.createElement(RunsView, { page: pageOf([runRow()], 2), error: null }),
    );
    expect(html).toContain('2');
    expect(html.toLowerCase()).toContain('permission');
  });

  it('draws an unreachable Runtime instead of a blank panel', () => {
    const html = renderToStaticMarkup(React.createElement(RunsView, {
      page: null, error: { code: 'RuntimeUnavailable', message: 'no Runtime is running' },
    }));
    expect(html).toContain('no Runtime is running');
  });

  it('draws an empty state when there are no Runs at all', () => {
    const html = renderToStaticMarkup(
      React.createElement(RunsView, { page: pageOf([]), error: null }),
    );
    expect(html.toLowerCase()).toContain('no agent runs');
  });
});

describe('the row renders the frozen projection, not a re-derivation', () => {
  it('shows the Run id exactly as the projection carries it', () => {
    const html = renderToStaticMarkup(React.createElement(RunsView, {
      page: pageOf([runRow({ id: 'agentRun_019fd383-3207-7333-ae57-a3f7f3d5cfb6' })]),
      error: null,
    }));
    expect(html).toContain('agentRun_019fd383-3207-7333-ae57-a3f7f3d5cfb6');
  });
});
