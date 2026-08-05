// NVK-KIMI-091 B1.2 — the tab strip's view-model (FZ-VIEW-017, FZ-VIEW-034).
//
// A strip entry joins two DIFFERENT authorities and must never blur them:
//   - the durable `terminalTab` record — a Shell fact, what windows Chris has;
//   - the Runtime's `TerminalTabView` — a session fact, what is actually running.
//
// The join is where FZ-VIEW-034 gets broken in practice. When the Runtime does
// not report a session, the honest answer is "unknown". The tempting answers —
// drop the tab, draw it as exited, draw `0 windows attached` — are each a
// different false claim, and the last one is the false zero the freeze names
// outright ("Unavailable is not zero").
import { describe, it, expect } from 'vitest';
import {
  composeTabStrip, describeTabSession, titleForTab,
} from '../contract/terminalTabStrip.js';
import {
  SESSION_A, SESSION_B, sessionView as view, tabRecord as tab,
} from './fixtures/terminalTab.js';

describe('composeTabStrip: one entry per open tab, in stored order', () => {
  it('keeps the order the store returned, so two boots agree', () => {
    const entries = composeTabStrip(
      [tab({ id: 'tab-b', terminalSessionId: SESSION_B }), tab({ id: 'tab-a' })],
      [],
    );
    expect(entries.map((entry) => entry.tabId)).toEqual(['tab-b', 'tab-a']);
  });

  it('carries the Runtime view for a session the Runtime reports', () => {
    const [entry] = composeTabStrip([tab()], [view({ attachedControllerCount: 2 })]);
    expect(entry.session).toEqual({ known: true, view: view({ attachedControllerCount: 2 }) });
  });

  it('two windows on ONE session are two tabs — a session may be shown twice', () => {
    const entries = composeTabStrip(
      [tab({ id: 'tab-a' }), tab({ id: 'tab-a2' })],
      [view()],
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.session.known)).toBe(true);
  });

  it('the tab whose session the Runtime does not report is UNKNOWN, not dropped', () => {
    const entries = composeTabStrip([tab({ id: 'tab-b', terminalSessionId: SESSION_B })], [view()]);
    expect(entries).toHaveLength(1);
    expect(entries[0].session).toEqual({ known: false });
  });

  it('and it never invents a view to fill the hole', () => {
    const [entry] = composeTabStrip([tab({ terminalSessionId: SESSION_B })], []);
    expect(entry.session).not.toHaveProperty('view');
  });

  it('carries mode and session id through untouched — the record is the authority', () => {
    const [entry] = composeTabStrip([tab({ mode: 'calm' })], []);
    expect({ mode: entry.mode, session: entry.terminalSessionId })
      .toEqual({ mode: 'calm', session: SESSION_A });
  });
});

describe('describeTabSession: FZ-VIEW-034 — unavailable is not zero', () => {
  it('says unknown when the Runtime does not report the session', () => {
    const [entry] = composeTabStrip([tab({ terminalSessionId: SESSION_B })], []);
    expect(describeTabSession(entry)).toBe('Session unknown');
  });

  it('and never draws that unknown as a controller count', () => {
    const [entry] = composeTabStrip([tab({ terminalSessionId: SESSION_B })], []);
    const drawn = describeTabSession(entry);
    expect(drawn).not.toMatch(/\b0\b/u);
    expect(drawn.toLowerCase()).not.toContain('attached');
  });

  it('an EXITED session is exited, never folded into unknown — different facts', () => {
    const [entry] = composeTabStrip([tab()], [view({ status: 'exited' })]);
    expect(describeTabSession(entry)).toBe('Exited');
  });

  it('a live session states running, and a real zero controller count is allowed', () => {
    const [live] = composeTabStrip([tab()], [view({ attachedControllerCount: 0 })]);
    expect(describeTabSession(live)).toBe('Running · 0 windows attached');
  });

  it('a session that needs a person says so in words, not in a colour', () => {
    const [entry] = composeTabStrip([tab()], [view({ status: 'recovery-required' })]);
    expect(describeTabSession(entry)).toBe('Needs recovery');
  });
});

describe('titleForTab: the strip is never blank', () => {
  it('uses the title the record carries', () => {
    expect(titleForTab(tab({ title: 'build' }))).toBe('build');
  });

  it('falls back to the session, because an untitled tab still has to be clickable', () => {
    expect(titleForTab(tab({ title: '' }))).toBe('Terminal 000a');
  });

  it('treats whitespace as untitled — a tab named " " is a blank button', () => {
    expect(titleForTab(tab({ title: '   ' }))).toBe('Terminal 000a');
  });
});
