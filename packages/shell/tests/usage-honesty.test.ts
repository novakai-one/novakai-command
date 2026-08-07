// NVK-KIMI-091 B2.2 — the usage honesty laws (FZ-VIEW-009/010/012).
//
// The screen already refused the obvious lie: an unmeasured count prints as an
// em dash, never as 0. What it did NOT refuse is the subtler one, one row down
// — the totals line.
//
// `totals()` sums the sessions that HAVE a number and skips the ones that do
// not, which is correct. The row is then labelled "All sessions", which is a
// claim about scope, and with two of five sessions unmeasured that claim is
// false. FZ-VIEW-012 names this exact failure for the overlap case: report
// partial with a limitation, "never a sum or a discard". A sum presented as
// the whole is both at once.
//
// So the label is now derived from coverage rather than asserted, and the
// weakest metric bounds what the row may claim: a totals line cannot be more
// complete than the least complete number standing in it.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { totals, describeTotalsScope, formatRunUsage } from '../contract/usage.js';
import { UsageView, RunUsageView } from '../ui/screens/supervision/UsageScreen.js';
import {
  runUsageRow as runRow, usageRow as row, usageTable as table,
} from './fixtures/usageRow.js';

describe('a total knows how much of the table it actually covers', () => {
  it('counts the sessions that contributed, not just the sum', () => {
    const measured = totals([row(), row(), row({ inputTokens: null })]);
    expect(measured.input).toEqual({ value: 200, measured: 2, rows: 3 });
  });

  it('nothing measurable is a null total over zero rows, never a zero', () => {
    const none = totals([row({ inputTokens: null }), row({ inputTokens: null })]);
    expect(none.input).toEqual({ value: null, measured: 0, rows: 2 });
  });
});

describe('"All sessions" is a claim, and may only be made when it is true', () => {
  it('says all sessions when every session contributed', () => {
    expect(describeTotalsScope(totals([row(), row()]))).toBe('All sessions');
  });

  it('says how many contributed when some did not', () => {
    expect(describeTotalsScope(totals([row(), row(), row({ inputTokens: null })])))
      .toBe('2 of 3 sessions');
  });

  it('the weakest metric bounds the claim — a line is only as complete as its worst number', () => {
    // Input measured everywhere, output measured on one of two. The row still
    // may not say "All sessions": one of the two numbers standing in it is not.
    expect(describeTotalsScope(totals([row(), row({ outputTokens: null })])))
      .toBe('1 of 2 sessions');
  });

  it('nothing measurable says so rather than quietly claiming everything', () => {
    expect(describeTotalsScope(totals([row({ inputTokens: null, outputTokens: null })])))
      .toBe('0 of 1 session');
  });

  it('the screen draws the derived scope, not the words "All sessions" by hand', () => {
    const html = renderToStaticMarkup(React.createElement(UsageView, {
      table: table([row(), row({ inputTokens: null })]),
    }));
    expect(html).toContain('1 of 2 sessions');
    expect(html).not.toContain('All sessions');
  });
});

describe('FZ-VIEW-010: a Run with nothing measurable still gets its row', () => {
  it('draws the run, its identity, and dashes — not an omission', () => {
    const html = renderToStaticMarkup(React.createElement(RunUsageView, {
      table: { at: '2026-08-06T10:05:00.000Z', rows: [runRow()] },
    }));
    expect(html).toContain('Kimi');
    expect(html).toContain('unavailable');
    expect(html).not.toContain('No agent runs yet');
  });

  /**
   * Found in a screenshot, not in a test. The row put the run id AND all five
   * metrics into `meta` as one string, joined with a `\n` that HTML does not
   * honour. Two consequences, both invisible to a markup assertion that only
   * asks "does the text appear somewhere":
   *
   *   - the meta grew unbounded, squeezed `k-row__label` to zero width, and the
   *     agent's NAME vanished from its own row — the one thing that says whose
   *     run this is;
   *   - the line ran past the panel edge, so cost and turns were cut off. The
   *     values FZ-VIEW-010 insists must be shown were on the page and not on
   *     the screen.
   *
   * So the guard is structural: the metrics live in their own element, and the
   * row's meta stays short enough that a name can survive beside it.
   */
  it('draws the agent name on its own row, and the metrics outside the meta', () => {
    const html = renderToStaticMarkup(React.createElement(RunUsageView, {
      table: { at: '2026-08-06T10:05:00.000Z', rows: [runRow()] },
    }));
    expect(html).toContain('<span class="k-row__label">Kimi</span>');
    const meta = /<span class="k-row__meta">([^<]*)<\/span>/u.exec(html)?.[1] ?? '';
    expect(meta).not.toContain('unavailable');
    expect(meta).not.toContain('agentRun_');
    expect(meta).not.toContain('\n');
    // And the values are still on the page, in a place with room for them.
    expect(html).toContain('nv-usage__runValues');
  });

  it('and every one of its five values is a dash, never a zero', () => {
    const said = formatRunUsage(runRow());
    expect(said).not.toMatch(/\b0\b/u);
    expect(said.match(/—/gu) ?? []).toHaveLength(5);
  });
});
