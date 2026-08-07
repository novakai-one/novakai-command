// NVK-KIMI-091 B1.2 — what the tab strip DRAWS.
//
// Two obligations pull in opposite directions here and both are real:
//
//   FZ-VIEW-034 says every mixed state must render plain, non-contradictory
//   status. Chris's standing UI law says a badge on every row is the most
//   overstimulating thing you can build, and that ornament belongs only to the
//   element that IS the exception.
//
// They are reconciled by drawing status ONLY where there is something a person
// has to know: a session the Runtime cannot account for, or one that needs
// recovery. A healthy tab is a title and nothing else. That is not status being
// hidden — the selected session's full truth line sits directly beside the
// strip, always, and is asserted in terminal-screen.test.ts.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalTabStrip } from '../ui/screens/terminal/TerminalTabStrip.js';
import { composeTabStrip } from '../contract/terminalTabStrip.js';
import {
  SESSION_B, sessionView as view, tabRecord as tab,
} from './fixtures/terminalTab.js';
import type { TerminalTabRecord } from '../contract/terminalTab.js';
import type { TerminalTabView } from '../contract/terminalServices.js';

const strip = (
  tabs: readonly TerminalTabRecord[],
  views: readonly TerminalTabView[],
  selectedTabId: string | null,
): string => renderToStaticMarkup(React.createElement(TerminalTabStrip, {
  entries: composeTabStrip(tabs, views),
  selectedTabId,
  onSelect: () => {},
  onNewTab: () => {},
}));

describe('the strip draws the tabs that exist', () => {
  it('one control per open tab, each carrying its name', () => {
    const html = strip(
      [tab({ id: 'tab-a', title: 'build' }), tab({ id: 'tab-b', terminalSessionId: SESSION_B })],
      [view()],
      'tab-a',
    );
    expect(html).toContain('build');
    // The untitled one still names itself — a blank button is unclickable in practice.
    expect(html).toContain('Terminal 000b');
  });

  it('marks exactly one tab selected, so the strip and the viewport agree', () => {
    const html = strip([tab({ id: 'tab-a' }), tab({ id: 'tab-b', terminalSessionId: SESSION_B })], [view()], 'tab-b');
    expect(html.match(/data-selected="true"/gu) ?? []).toHaveLength(1);
  });

  it('with nothing selected it marks nothing — never a default lie about what you are looking at', () => {
    const html = strip([tab()], [view()], null);
    expect(html).not.toContain('data-selected="true"');
  });

  it('offers a way to open another one', () => {
    expect(strip([tab()], [view()], 'tab-a')).toContain('data-testid="terminal-tab-new"');
  });
});

describe('status is drawn where there is something to know, and nowhere else', () => {
  it('a healthy tab is a name and nothing else — no badge, no dot, no count', () => {
    const html = strip([tab({ title: 'build' })], [view()], 'tab-a');
    expect(html).not.toContain('k-row__meta');
    expect(html).not.toContain('windows attached');
  });

  it('a session the Runtime cannot account for says so, in words', () => {
    const html = strip([tab({ terminalSessionId: SESSION_B })], [], 'tab-a');
    expect(html).toContain('Session unknown');
    expect(html).toContain('data-session="unknown"');
  });

  it('and that unknown is never drawn as a zero (FZ-VIEW-034)', () => {
    const html = strip([tab({ terminalSessionId: SESSION_B })], [], 'tab-a');
    expect(html).not.toContain('0 windows attached');
  });

  it('a session needing a person says so — the one other exception', () => {
    const html = strip([tab()], [view({ status: 'recovery-required' })], 'tab-a');
    expect(html).toContain('Needs recovery');
    expect(html).toContain('data-session="attention"');
  });

  it('an exited session is stated too — it is why the tab has gone silent', () => {
    expect(strip([tab()], [view({ status: 'exited' })], 'tab-a')).toContain('Exited');
  });

  it('the strip is a tablist, so a keyboard and a screen reader both find it', () => {
    const html = strip([tab()], [view()], 'tab-a');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Terminal tabs"');
  });
});

describe('the strip obeys the standing UI laws', () => {
  it('composes kit components only — the row is the kit\'s row', () => {
    expect(strip([tab()], [view()], 'tab-a')).toContain('k-row');
  });

  it('spends no accent: the composed viewport already has its one gold', () => {
    const html = strip([tab({ terminalSessionId: SESSION_B })], [], 'tab-a');
    expect(html).not.toContain('--accent');
    expect(html.match(/#(d0a14b|e2ba6e|c98f2f)/giu) ?? []).toHaveLength(0);
  });
});
