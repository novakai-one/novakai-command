// Lane B — watcher truth reaches a Shell-renderable operator list.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WatcherListView } from '../contract/watchers.js';
import { WatchersView } from '../ui/screens/supervision/WatchersScreen.js';
import { watcherListingFromWire } from '../app/serverClient.js';

const listing = (overrides: Partial<WatcherListView> = {}): WatcherListView => ({
  rules: [{
    id: 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab',
    subject: {
      kind: 'agent-run',
      agentRunId: 'agentRun_019fd000-0000-7000-8000-0000000000a1',
    },
    condition: { kind: 'activity-drift' },
    recipient: { kind: 'human', principalId: 'person_chris' },
    deliveryMode: 'queue-only',
    status: 'active',
    recordVersion: 3,
  }],
  deadlines: [{
    id: 'watchDeadline_' + 'a'.repeat(52),
    watchRuleId: 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab',
    state: 'armed',
    dueAt: '2026-08-03T02:00:00.000Z',
    activityGeneration: 4,
    driftPhase: 'observing',
  }],
  omissions: [],
  ...overrides,
});

describe('Shell watcher list', () => {
  it('maps the public B3 wire result into the Shell service view', () => {
    const mapped = watcherListingFromWire({
      ok: true,
      value: {
        ...listing(),
        deadlines: [{
          ...listing().deadlines[0]!,
          driftState: { phase: 'observing' },
        }],
      },
    });
    expect(mapped.deadlines[0]?.driftPhase).toBe('observing');
  });

  it('renders subject, condition, lifecycle, delivery and current deadline truth', () => {
    const html = renderToStaticMarkup(React.createElement(WatchersView, {
      listing: listing(),
    }));
    expect(html).toContain('agentRun_019fd000-0000-7000-8000-0000000000a1');
    expect(html).toContain('activity drift');
    expect(html).toContain('active');
    expect(html).toContain('queue only');
    expect(html).toContain('armed');
    expect(html).toContain('generation 4');
  });

  it('draws an explicit empty state', () => {
    const html = renderToStaticMarkup(React.createElement(WatchersView, {
      listing: listing({ rules: [], deadlines: [] }),
    }));
    expect(html).toContain('No watcher rules yet');
  });

  it('reports permission omissions without pretending the list is complete', () => {
    const html = renderToStaticMarkup(React.createElement(WatchersView, {
      listing: listing({ omissions: [{ reason: 'permission', count: 2 }] }),
    }));
    expect(html).toContain('2 watcher rules are hidden by permissions');
  });
});
