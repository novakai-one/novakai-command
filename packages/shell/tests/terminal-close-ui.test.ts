// NVK-KIMI-091 B1.6 — what the close question DRAWS.
//
// The contract decides; this pins the two things a picture can get wrong even
// when the decision is right:
//
//   1. an unreachable Stop must not be a control. A disabled button is still a
//      thing to press at, and it invites the press twice. The limit is stated as
//      a FACT, in the faint tier, next to the choices that work — the same
//      separation seat 5 had to make between an attention mark and an ack
//      affordance (a row that can do nothing has nothing to press).
//   2. the DEFAULT must be the safe one. "Keep running" is the row's default
//      result, so it is the primary and the focused control; a dialog whose
//      emphasised button stops a process is a dialog that will stop one by
//      reflex.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalCloseAsk } from '../ui/screens/terminal/TerminalCloseAsk.js';
import { decideTabClose, type TerminalStopDoors } from '../contract/terminalClose.js';
import type { TabSessionTruth } from '../contract/terminalTabStrip.js';
import { sessionView as view } from './fixtures/terminalTab.js';

const NO_DOORS: TerminalStopDoors = { agentRunLifecycle: false };
const WITH_LIFECYCLE: TerminalStopDoors = { agentRunLifecycle: true };
const agentRun = (): TabSessionTruth =>
  ({ known: true, view: view({ status: 'live', owner: { kind: 'agent-run', label: 'agentRun_7' } }) });

/** The label of the ONE emphasised control — a 200-char slice spills into the next. */
const primaryLabel = (html: string): string =>
  html.match(/k-btn--primary[^>]*>([^<]*)</u)?.[1] ?? '';

const ask = (session: TabSessionTruth, doors: TerminalStopDoors): string => {
  const decision = decideTabClose(session, doors);
  if (!decision.mustAsk) throw new Error('fixture must be a session that asks');
  return renderToStaticMarkup(React.createElement(TerminalCloseAsk, {
    tabTitle: 'build',
    decision,
    onChoose: () => {},
  }));
};

describe('the question', () => {
  it('is a dialog, named, and names the window it is about', () => {
    const html = ask({ known: true, view: view({ status: 'live' }) }, NO_DOORS);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('build');
  });

  it('states what happens to the session, in words, before any button', () => {
    const html = ask({ known: true, view: view({ status: 'live' }) }, NO_DOORS);
    expect(html).toContain('keeps running in the background Runtime');
  });

  it('makes Keep running the primary — the safe choice is the emphasised one', () => {
    const html = ask({ known: true, view: view({ status: 'live' }) }, NO_DOORS);
    const primaries = html.match(/k-btn--primary/gu) ?? [];
    expect(primaries).toHaveLength(1);
    expect(primaryLabel(html)).toBe('Keep running');
  });

  it('offers Cancel', () => {
    expect(ask({ known: true, view: view({ status: 'live' }) }, NO_DOORS))
      .toContain('data-testid="terminal-close-cancel"');
  });
});

describe('an unreachable Stop is a stated limit, never a control', () => {
  it('draws no Stop button for a plain shell', () => {
    const html = ask({ known: true, view: view({ status: 'live' }) }, WITH_LIFECYCLE);
    expect(html).not.toContain('data-testid="terminal-close-stop"');
  });

  it('says why, where the choice would have been', () => {
    const html = ask({ known: true, view: view({ status: 'live' }) }, WITH_LIFECYCLE);
    expect(html).toContain('data-testid="terminal-close-stop-unavailable"');
    expect(html).toContain('type exit');
  });

  it('never draws a disabled Stop — the limit is read, not clicked at', () => {
    const html = ask(agentRun(), NO_DOORS);
    expect(html).not.toContain('disabled');
    expect(html).toContain('data-testid="terminal-close-stop-unavailable"');
  });

  it('draws the real Stop when a host can actually keep the promise', () => {
    const html = ask(agentRun(), WITH_LIFECYCLE);
    expect(html).toContain('data-testid="terminal-close-stop"');
    expect(html).not.toContain('data-testid="terminal-close-stop-unavailable"');
    // Still not the primary: stopping a Run stays the deliberate choice.
    expect(primaryLabel(html)).toBe('Keep running');
  });
});

describe('the leading fact must be true of every button under it', () => {
  // Read off a PNG, with the plain-shell dialog beside it. Both said "The
  // session keeps running in the background Runtime" — TRUE of the plain shell,
  // where Keep running is the only thing that can happen, and a half-truth of
  // the Agent one, where the button directly beneath it exists to make it false.
  //
  // It is the same defect the close FLOW fixes one step later (the press-time
  // claim is replaced, not carried, once a stop succeeds). The dialog carried it.
  it('states only what is true NOW when a stop is also on offer', () => {
    const claim = 'terminal-close-claim';
    const html = ask(agentRun(), WITH_LIFECYCLE);
    const said = html.match(new RegExp(`${claim}"[^>]*>([^<]*)<`, 'u'))?.[1] ?? '';
    expect(said).toContain('is running in the background Runtime');
    expect(said).toContain('Closing this window detaches it');
    expect(said).not.toContain('keeps running');
  });

  it('keeps the outcome sentence when Keep running IS the only outcome', () => {
    // Nothing to hedge here: with no reachable stop, the fact and the result of
    // the only available press are the same sentence. B1.6's wording stands.
    expect(ask({ known: true, view: view({ status: 'live' }) }, WITH_LIFECYCLE))
      .toContain('keeps running in the background Runtime');
    expect(ask(agentRun(), NO_DOORS)).toContain('keeps running in the background Runtime');
  });
});

describe('the two choices are not drawn as equals', () => {
  // The defect a static render cannot see: with the kit's primary being a faint
  // wash, both buttons came out at the same tier and the safe default was
  // invisible. Read off a screenshot, then pinned here so it cannot come back.
  const css = readFileSync(
    path.join(import.meta.dirname, '../ui/screens/terminal/TerminalScreen.css'), 'utf8',
  );
  const choices = css.slice(css.indexOf('.nvkTerminalAskChoices'));

  it('the primary carries weight and full ink of its own', () => {
    expect(choices).toMatch(/\.k-btn--primary\s*\{[^}]*font-weight/u);
    expect(choices).toMatch(/\.k-btn--primary\s*\{[^}]*var\(--ink\)/u);
  });

  it('the way out sits a tier back', () => {
    expect(choices).toMatch(/not\(\.k-btn--primary\)\s*\{[^}]*var\(--ink-3\)/u);
  });

  it('and none of it reaches for the one accent', () => {
    expect(choices).not.toContain('--accent');
  });
});
