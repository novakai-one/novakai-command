// NVK-KIMI-091 — what the Calm pacing picker DRAWS (FZ-VIEW-017).
//
// The frozen record carries exactly two pacing inputs. The one thing a picker
// can do that no engine test would catch is grow a third: a "Calm preset", a
// "smooth scrolling" toggle, a zoom. FZ-VIEW-018 closed the record's field set,
// so a control that offers anything else is offering something with nowhere to
// live — it would work until reload and then be gone.
//
// The interaction half (a refused value is drawn, an accepted one is written) is
// proven in the browser, where the typing is real: b16-pacing.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalPacing } from '../ui/screens/terminal/TerminalPacing.js';
import { CALM_PACING_LIMITS } from '../contract/terminalTab.js';

const picker = (maxBufferedLines = 2_000, revealLinesPerSecond = 24): string =>
  renderToStaticMarkup(React.createElement(TerminalPacing, {
    pacing: { maxBufferedLines, revealLinesPerSecond },
    onChange: () => {},
  }));

describe('the picker offers the two frozen inputs and nothing else', () => {
  it('exactly two controls', () => {
    const html = picker();
    expect(html.match(/<input/gu) ?? []).toHaveLength(2);
  });

  it('one per frozen field, named as the record names it', () => {
    const html = picker();
    for (const field of Object.keys(CALM_PACING_LIMITS)) {
      expect(html).toContain(`data-testid="pacing-${field}"`);
    }
  });

  it('carries the values in force, not defaults', () => {
    const html = picker(500, 6);
    expect(html).toContain('value="500"');
    expect(html).toContain('value="6"');
  });

  it('states each range where the value is typed', () => {
    const html = picker();
    expect(html).toContain('100–100,000');
    expect(html).toContain('1–2,000');
  });

  it('bounds the control itself, so the range is not only advice', () => {
    const html = picker();
    expect(html).toContain('min="100"');
    expect(html).toContain('max="100000"');
  });

  it('draws no refusal until something is refused', () => {
    expect(picker()).not.toContain('k-error');
  });
});
