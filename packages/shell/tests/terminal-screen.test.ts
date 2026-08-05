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
import {
  describeBootFailure, describeTerminal, type TerminalTabView,
} from '../contract/terminalServices.js';
import {
  SCREEN_CONTEXT_SUPPORT, describeScreenContextSupport,
} from '../contract/screenContext.js';

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
    screenContext: 'unavailable',
    mode: 'raw' as const,
    onModeChange: () => {},
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

  /**
   * Found in a screenshot, not in a test — and it is the SAME defect seat 2
   * found in the strip, one row down. The bar now carries two facts from two
   * different authorities side by side at the same ink tier:
   *
   *   "…running in the background Runtime" — the RUNTIME's, about this session;
   *   "Screen context: unavailable"        — the SHELL's, about what an agent
   *                                          can see of this window.
   *
   * With only a gap between them they read as one continuous sentence, which
   * quietly attributes the Shell's statement to the Runtime. The hairline is
   * the device this stylesheet already uses for exactly this, and it costs no
   * colour and no ornament.
   */
  it('separates the Shell\'s screen-context fact from the Runtime\'s truth line', () => {
    const css = readFileSync(path.join(TERMINAL_DIR, 'TerminalScreen.css'), 'utf8');
    const rule = /\.nvkTerminalScreenContext\s*\{[^}]*\}/u.exec(css)?.[0] ?? '';
    expect(rule).toContain('border-left');
    expect(rule).toContain('var(--hairline)');
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

/**
 * Found in a browser, not in a test: against a host with no nvk-server the
 * terminal page drew `Unexpected token '<', "<!doctype "... is not valid JSON`.
 * That is red gate 5 satisfied on a technicality — something IS drawn — while
 * telling Chris nothing about what is wrong or whether his shells are safe.
 */
describe('a boot failure says what could not be reached', () => {
  it('names the Runtime, and keeps the raw cause instead of replacing it', () => {
    const said = describeBootFailure(new Error('Unexpected token \'<\', "<!doctype "... is not valid JSON'));
    expect(said).toContain('Novakai Runtime');
    expect(said).toContain('is not valid JSON');
  });

  it('says the terminals are unaffected — the question a person actually has', () => {
    expect(describeBootFailure(new Error('boom'))).toContain('still running');
  });

  it('handles a thrown non-Error without turning it into "[object Object]"', () => {
    expect(describeBootFailure({ nope: true })).toContain('Novakai Runtime');
    expect(describeBootFailure({ nope: true })).not.toContain('[object Object]');
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
  /**
   * NVK-KIMI-025 repair 3: this used to hand the chrome a literal and then find
   * the same literal in the markup — a prop echo that would pass with the truth
   * line broken. The sentence is now PRODUCED by `describeTerminal`, so the
   * chrome is checked against what the tab actually draws.
   *
   * The other end of the chain — that `describeTerminal(toTabView(...))` is fed
   * a REAL Runtime's view of a REAL session — is proved over the wire in
   * packages/server/tests/b3-controller-truth.test.ts.
   */
  it('draws the truth line the tab builds, carrying its tone', () => {
    const settledLine = describeTerminal(view({ attachedControllerCount: 0 }));
    const html = chrome({ truth: settledLine, tone: 'settled' });
    expect(settledLine).toBe(
      'Started as a plain shell · 0 windows attached · running in the background Runtime',
    );
    expect(html).toContain(settledLine);
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

  /**
   * B1.2: the strip sits ABOVE the truth line, not inside it. The strip says
   * which windows exist and stays quiet about healthy ones; the truth line says
   * everything about the one you are looking at. Both are always on screen, so
   * a quiet strip is never the only thing standing between Chris and a status.
   */
  it('hosts the tab strip, and the selected session\'s truth line beside it', () => {
    const html = chrome({
      strip: React.createElement('div', { 'data-testid': 'stub-strip' }, 'tabs go here'),
      truth: describeTerminal(view()),
    });
    expect(html).toContain('data-testid="stub-strip"');
    expect(html).toContain('1 window attached');
    expect(html.indexOf('stub-strip')).toBeLessThan(html.indexOf('data-testid="terminal-truth"'));
  });

  it('draws no strip region at all when there is none to draw', () => {
    expect(chrome()).not.toContain('data-testid="terminal-strip"');
  });

  /**
   * B1.4 / FZ-VIEW-016 — the Raw-mode display obligation.
   *
   * `screenContext` is a REQUIRED prop, and that is the point: an optional one
   * can be forgotten, and a forgotten obligation looks exactly like a screen
   * that has nothing to say. The compiler now refuses to draw a terminal that
   * does not state what an agent can see of it.
   *
   * It is drawn in BOTH modes rather than gated on Raw. Raw is where the freeze
   * puts the obligation, and a gate is a way to fail it — but the fact itself
   * is a property of this Shell's capture ability, not of the tab's mode, so a
   * value that appeared and vanished as Chris switched modes would read as a
   * bug about the wrong thing.
   */
  it('states what an agent can see of this screen — in every one of the three states', () => {
    for (const support of SCREEN_CONTEXT_SUPPORT) {
      const html = chrome({ screenContext: support });
      expect({ support, shown: html.includes(describeScreenContextSupport(support)) })
        .toEqual({ support, shown: true });
      expect(html).toContain('data-testid="terminal-screen-context"');
    }
  });

  it('draws unavailable as WORDS, never as an absent line', () => {
    const html = chrome({ screenContext: 'unavailable' });
    expect(html).toContain('unavailable');
    // The false-empty defect B0 found on Runs, refused one screen over: the
    // region exists in the state that has the least to report.
    expect(html).toContain('data-testid="terminal-screen-context"');
  });

  it('keeps the screen-context line quiet — it is chrome, not the exception', () => {
    const html = chrome({ screenContext: 'unavailable' });
    // No second attention signal: no dot, no chip, no tone attribute of its own.
    expect(html).not.toMatch(/data-testid="terminal-screen-context"[^>]*data-tone/u);
  });

  it('every element it draws is a kit component', () => {
    const html = chrome({ watchingOnly: true, problem: 'x' });
    for (const kitClass of ['k-stack', 'k-text', 'k-btn', 'k-surface']) {
      expect({ kitClass, present: html.includes(kitClass) }).toEqual({ kitClass, present: true });
    }
  });
});
