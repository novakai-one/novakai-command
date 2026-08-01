// NVK-KIMI-023 — the terminal tab's PRESENTATION contract (B3a seal blocker).
//
// The tab was built with hand-written markup and its own gold: it broke both
// standing UI laws at once — one attention signal per composed viewport
// (tools/lint-accent.mjs) and screens compose kit components only
// (tools/lint-kit.mjs).
//
// This file pins the presentation so it cannot drift back:
//   - the chrome is a pure function of what the controller knows;
//   - it is composed from ui/kit, so the kit gate is structural, not stylistic;
//   - it contributes ZERO accent — attention is drawn with weight, ink tier and
//     a rule, never with the one gold the rail already owns.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalChrome, toneFor } from '../ui/screens/terminal/TerminalChrome.js';
import type { TerminalTabView } from '../contract/terminalServices.js';

const TERMINAL_DIR = path.resolve(import.meta.dirname, '../ui/screens/terminal');

const view = (overrides: Partial<TerminalTabView> = {}): TerminalTabView => ({
  terminalSessionId: 'terminal_00000000-0000-7000-8000-000000000001',
  status: 'live',
  owner: { kind: 'plain-shell', label: 'novakai-shell' },
  workingDirectory: '/tmp',
  attachedControllerCount: 1,
  holdsInputLease: true,
  replay: { earliestSequence: 0, latestSequence: 12 },
  nextInputSequence: 1,
  ...overrides,
});

const chrome = (props: Partial<React.ComponentProps<typeof TerminalChrome>> = {}) =>
  renderToStaticMarkup(React.createElement(TerminalChrome, {
    truth: 'Reaching the background Runtime…',
    tone: 'calm',
    watchingOnly: false,
    problem: null,
    surfaceRef: null,
    onClose: () => {},
    ...props,
  }));

describe('the terminal tab obeys the two standing UI laws', () => {
  it('kit gate green — the tab composes kit components, no hand-written markup', () => {
    const out = execFileSync('node', ['tools/lint-kit.mjs'], { encoding: 'utf8' });
    expect(out).toContain('KIT GATE GREEN');
  });

  it('accent gate green — the tab contributes NO second attention signal', () => {
    const out = execFileSync('node', ['tools/lint-accent.mjs'], { encoding: 'utf8' });
    // Exactly one across the whole composed viewport, and it is not ours.
    expect(out).toContain('--accent used 1×');
  });

  it('the tab\'s own stylesheet reaches for the accent token zero times', () => {
    const css = readFileSync(path.join(TERMINAL_DIR, 'TerminalScreen.css'), 'utf8');
    expect(css.match(/--accent/g) ?? []).toHaveLength(0);
  });

  it('and it does not smuggle the gold back in as a literal', () => {
    // Amber scarcity is about what is on screen, not about which spelling was
    // used to get it there — including the xterm theme the gate cannot see.
    for (const file of readdirSync(TERMINAL_DIR)) {
      const src = readFileSync(path.join(TERMINAL_DIR, file), 'utf8');
      expect({ file, gold: src.match(/#(d0a14b|e2ba6e|c98f2f)/gi) ?? [] })
        .toEqual({ file, gold: [] });
    }
  });
});

describe('tone: one signal at a time, and it releases when resolved', () => {
  it('a session that needs a person is the attention tone', () => {
    expect(toneFor(view({ status: 'recovery-required' }), false)).toBe('attention');
  });

  it('detaching settles the line — the signature moment, no sentence announces it', () => {
    expect(toneFor(view(), true)).toBe('settled');
  });

  it('everything else is calm', () => {
    expect(toneFor(view(), false)).toBe('calm');
    expect(toneFor(null, false)).toBe('calm');
  });

  it('a session needing recovery outranks a settled tab — never two signals', () => {
    expect(toneFor(view({ status: 'recovery-required' }), true)).toBe('attention');
  });
});

describe('what the chrome draws', () => {
  it('the truth line the Runtime reported, carrying its tone', () => {
    const html = chrome({ truth: '0 windows attached · running in the background Runtime', tone: 'settled' });
    expect(html).toContain('0 windows attached · running in the background Runtime');
    expect(html).toContain('data-tone="settled"');
    expect(html).toContain('data-testid="terminal-truth"');
  });

  it('a mount point for the terminal itself', () => {
    expect(chrome()).toContain('data-testid="terminal-surface"');
  });

  it('one control, and it closes the window — nothing here can kill a session', () => {
    const html = chrome();
    expect(html).toContain('data-testid="terminal-close"');
    expect(html).toContain('Close window');
    expect(html.toLowerCase()).not.toContain('kill');
    expect(html.toLowerCase()).not.toContain('terminate');
  });

  it('the watch-only state is stated once, and only while watching', () => {
    expect(chrome({ watchingOnly: true })).toContain('This one is watching');
    expect(chrome({ watchingOnly: false })).not.toContain('This one is watching');
  });

  it('a failure is drawn, never swallowed', () => {
    expect(chrome({ problem: 'lease-lost: another window took the lease' }))
      .toContain('lease-lost: another window took the lease');
    expect(chrome()).not.toContain('data-testid="terminal-problem"');
  });

  it('every element it draws is a kit component', () => {
    const html = chrome({ watchingOnly: true, problem: 'x' });
    for (const kitClass of ['k-stack', 'k-text', 'k-btn', 'k-surface']) {
      expect({ kitClass, present: html.includes(kitClass) }).toEqual({ kitClass, present: true });
    }
  });
});
