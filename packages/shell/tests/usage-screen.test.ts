// B1b slice 7 — the supervision usage surface (§8). Build 1's ONE user-facing
// addition, so it is held to the house rules rather than excused from them.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  exceptionOf, formatCount, formatIdentity, formatTokens, orderRows, totals,
  formatRunUsage, type RunUsageTableView, type UsageRowView, type UsageTableView,
} from '../contract/usage.js';
import { RunUsageView, UsageView } from '../ui/screens/supervision/UsageScreen.js';

const row = (partial: Partial<UsageRowView> = {}): UsageRowView => ({
  sessionId: 'sess_1', agentId: 'agent_1', provider: 'codex', model: 'cli-default',
  turns: 3, status: 'running', lastActivityAt: '2026-07-28T10:00:00.000Z',
  inputTokens: 1204, outputTokens: 88, cacheReadTokens: 0, cacheCreationTokens: 0,
  cumulativeAdjusted: false, providerTotalInputTokens: null,
  interrupted: null, drift: false, note: 'measured', ...partial,
});

const table = (rows: UsageRowView[]): UsageTableView => ({
  at: '2026-07-28T10:05:00.000Z', rows, tokenAccounting: 'read from provider transcripts',
});

describe('red gate 3: the screen composes kit components only', () => {
  it('lint-kit passes with the new screen covered', () => {
    const out = execFileSync('node', ['tools/lint-kit.mjs'], { encoding: 'utf8' });
    expect(out).toContain('KIT GATE GREEN');
  });

  it('lint-accent passes: the usage screen adds NO second attention signal', () => {
    const out = execFileSync('node', ['tools/lint-accent.mjs'], { encoding: 'utf8' });
    // Still exactly ONE across the whole composed viewport — the rail's single
    // attention marker. The usage screen contributes none.
    expect(out).toContain('--accent used 1×');
  });
});

describe('a count the server could not measure is never drawn as a number', () => {
  it('null prints as an em dash, not 0 — a zero would be a claim we cannot make', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(45338)).toBe('45,338');
  });

  it('a row with no readable transcript shows dashes on both sides', () => {
    expect(formatTokens(row({ inputTokens: null, outputTokens: null })))
      .toBe('— in · — out');
  });

  it('totals skip unknown counts rather than treating them as zero', () => {
    expect(totals([row({ inputTokens: 10 }), row({ inputTokens: null })]).input).toBe(10);
    expect(totals([row({ inputTokens: null }), row({ inputTokens: null })]).input).toBe(null);
    expect(totals([]).input).toBe(null);
  });
});

describe('order directs attention — the screen never writes a sentence that does', () => {
  it('drifting first, then interrupted, then running, then closed', () => {
    const ordered = orderRows([
      row({ sessionId: 'closed', status: 'closed' }),
      row({ sessionId: 'running', status: 'running' }),
      row({ sessionId: 'interrupted', interrupted: 'op_1' }),
      row({ sessionId: 'drifting', drift: true }),
    ]);
    expect(ordered.map((r) => r.sessionId)).toEqual(['drifting', 'interrupted', 'running', 'closed']);
  });

  it('within a group the most recent activity is first', () => {
    const ordered = orderRows([
      row({ sessionId: 'older', lastActivityAt: '2026-07-28T09:00:00.000Z' }),
      row({ sessionId: 'newer', lastActivityAt: '2026-07-28T11:00:00.000Z' }),
    ]);
    expect(ordered.map((r) => r.sessionId)).toEqual(['newer', 'older']);
  });
});

describe('calm density: only the exception is marked', () => {
  it('a healthy row gets no mark at all', () => {
    expect(exceptionOf(row())).toBe(null);
  });

  it('drift and interruption are the only two marks', () => {
    expect(exceptionOf(row({ drift: true }))).toBe('drift');
    expect(exceptionOf(row({ interrupted: 'op_1' }))).toBe('interrupted');
  });

  it('rendering four healthy sessions paints ZERO presence dots', () => {
    const html = renderToStaticMarkup(React.createElement(UsageView, {
      table: table([row({ sessionId: 'a' }), row({ sessionId: 'b' }), row({ sessionId: 'c' }), row({ sessionId: 'd' })]),
    }));
    expect(html.match(/k-presence/g) ?? []).toHaveLength(0);
  });

  it('one drifting session among four paints EXACTLY one', () => {
    const html = renderToStaticMarkup(React.createElement(UsageView, {
      table: table([
        row({ sessionId: 'a' }), row({ sessionId: 'b' }),
        row({ sessionId: 'c', drift: true }), row({ sessionId: 'd' }),
      ]),
    }));
    expect(html.match(/k-presence/g) ?? []).toHaveLength(1);
  });
});

describe('what the screen shows', () => {
  it('each row carries provider, model, turns and both token counts', () => {
    expect(formatIdentity(row({ turns: 7 }))).toBe('codex · cli-default · 7 turns');
    expect(formatIdentity(row({ turns: 1 }))).toBe('codex · cli-default · 1 turn');
    expect(formatTokens(row())).toBe('1,204 in · 88 out');
  });

  it('an empty table draws an empty state, never a blank panel', () => {
    const html = renderToStaticMarkup(React.createElement(UsageView, { table: table([]) }));
    expect(html).toContain('No provider sessions yet');
  });

  it('the accounting basis is shown, so no number on screen is unexplained', () => {
    const html = renderToStaticMarkup(React.createElement(UsageView, { table: table([row()]) }));
    expect(html).toContain('read from provider transcripts');
  });

  /**
   * B2.1 corrected this test rather than the screen passing it. As written it
   * PINNED the false empty — it asserted that a table nobody had answered yet
   * printed "No provider sessions yet", which is the lie B0 found on Runs. The
   * intent ("it renders before the first broadcast") is kept; the claim about
   * what it renders is now the honest one.
   */
  it('before the first broadcast arrives it renders, and does not claim there are none', () => {
    const html = renderToStaticMarkup(React.createElement(UsageView, { table: null }));
    expect(html).toContain('Reading sessions…');
    expect(html).not.toContain('No provider sessions yet');
  });
});

describe('B3d Run usage rows', () => {
  const runTable: RunUsageTableView = {
    at: '2026-08-03T03:00:00.000Z',
    rows: [{
      agentRunId: 'agentRun_019fd000-0000-7000-8000-0000000000a1',
      agentId: 'agent_123e4567-e89b-42d3-a456-426614174000',
      displayName: 'Usage Builder',
      provider: 'claude',
      model: 'cli-default',
      lifecycle: 'ready',
      inputTokens: {
        quality: 'unavailable', source: 'agents:provider-usage-evidence',
        limitations: ['no-provider-usage-evidence'],
      },
      outputTokens: {
        quality: 'measured', value: 75, source: 'provider-turn-completed', limitations: [],
      },
      cachedInputTokens: {
        quality: 'unavailable', source: 'agents:provider-usage-evidence',
        limitations: ['no-provider-usage-evidence'],
      },
      costMicros: {
        quality: 'unavailable', source: 'agents:provider-usage-evidence',
        limitations: ['no-provider-usage-evidence'],
      },
      providerTurns: {
        quality: 'measured', value: 1, source: 'provider-turn-completed', limitations: [],
      },
      observedAt: '2026-08-03T03:00:00.000Z',
      final: false,
    }],
  };

  it('renders absence as a dash with quality and the owning limitation', () => {
    const text = formatRunUsage(runTable.rows[0]!);
    expect(text).toContain('— in (unavailable: no-provider-usage-evidence)');
    expect(text).toContain('75 out (measured)');
    expect(text).not.toContain('0 in');
  });

  it('draws one row per Run and exposes quality in the Shell surface', () => {
    const html = renderToStaticMarkup(React.createElement(RunUsageView, { table: runTable }));
    expect(html).toContain('Usage Builder');
    expect(html).toContain('unavailable');
    expect(html).toContain('no-provider-usage-evidence');
    expect(html).toContain('agentRun_019fd000-0000-7000-8000-0000000000a1');
  });
});
