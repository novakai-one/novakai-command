// NVK-KIMI-091 B2.1 — the false empty, audited across every list screen.
//
// B0 found it on Runs and fixed it there. Seat 1 wrote down the suspicion that
// Runs was not the only one. This is that audit, as tests: every screen that
// holds a projection in `useState<T | null>(null)` and reads it as `?? []` is
// checked for the same lie — telling Chris the answer is "none" while nothing
// has answered.
//
// Why it matters more here than it looks: "No notifications" is the single most
// load-bearing sentence in this app. It is the one that lets Chris stop
// watching. Printing it before the inbox has answered is not a cosmetic bug —
// it is the app telling him he is free to look away when it does not know.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageView, RunUsageView } from '../ui/screens/supervision/UsageScreen.js';
import { NotificationInboxView } from '../ui/screens/supervision/NotificationInboxScreen.js';
import { WatchersView } from '../ui/screens/supervision/WatchersScreen.js';
import { AgentsScreen } from '../ui/screens/agents/AgentsScreen.js';
import { createMockServices } from '../app/mockServices.js';

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

describe('nothing has answered yet is NOT the answer "none"', () => {
  it('the usage table does not claim there are no sessions', () => {
    const waiting = html(React.createElement(UsageView, { table: null }));
    expect(waiting).not.toContain('No provider sessions yet');
    expect(waiting).toContain('Reading sessions…');
  });

  it('the Run usage table does not claim there are no runs', () => {
    const waiting = html(React.createElement(RunUsageView, { table: null }));
    expect(waiting).not.toContain('No agent runs yet');
    expect(waiting).toContain('Reading agent runs…');
  });

  it('the inbox does not tell Chris he is caught up before it has looked', () => {
    const waiting = html(React.createElement(NotificationInboxView, { inbox: null, error: null }));
    expect(waiting).not.toContain('No notifications');
    expect(waiting).toContain('Reading notifications…');
  });

  it('the watcher list does not claim there are no rules', () => {
    const waiting = html(React.createElement(WatchersView, { listing: null }));
    expect(waiting).not.toContain('No watcher rules yet');
    expect(waiting).toContain('Reading watchers…');
  });
});

describe('the agents roster, which holds its list in the connected screen', () => {
  /**
   * The other three views are pure and take their projection as a prop. This
   * one owns its list, so the "before the answer" state is reached by rendering
   * the screen itself — a static render runs no effects, which IS the moment
   * before the roster has answered.
   */
  const services = createMockServices();

  it('does not claim there are no agents before the roster has answered', () => {
    const waiting = html(React.createElement(AgentsScreen, { services }));
    expect(waiting).not.toContain('No agents defined yet');
    expect(waiting).toContain('Reading agents…');
  });
});

describe('and when an authority DID answer none, that is still said plainly', () => {
  it('an empty usage table is an empty usage table', () => {
    const answered = html(React.createElement(UsageView, {
      table: { at: '2026-08-06T00:00:00.000Z', rows: [], tokenAccounting: 'measured' },
    }));
    expect(answered).toContain('No provider sessions yet');
  });

  it('an empty Run usage table is an empty Run usage table', () => {
    const answered = html(React.createElement(RunUsageView, {
      table: { at: '2026-08-06T00:00:00.000Z', rows: [] },
    }));
    expect(answered).toContain('No agent runs yet');
  });

  it('an empty inbox is an empty inbox — this is the sentence that lets him rest', () => {
    const answered = html(React.createElement(NotificationInboxView, {
      inbox: { observedAt: '2026-08-06T00:00:00.000Z', rows: [] }, error: null,
    }));
    expect(answered).toContain('No notifications');
  });

  it('an empty watcher listing is an empty watcher listing', () => {
    const answered = html(React.createElement(WatchersView, {
      listing: { rules: [], deadlines: [], omissions: [] },
    }));
    expect(answered).toContain('No watcher rules yet');
  });
});
