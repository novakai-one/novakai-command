// B1b slice 7 — the supervision usage surface (§8). Build 1's ONE user-facing
// addition, so it is held to the house rules rather than excused from them.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  exceptionOf, formatCount, formatIdentity, formatTokens, orderRows, totals,
  type UsageRowView, type UsageTableView,
} from '../contract/usage.js';
import { UsageView } from '../ui/screens/supervision/UsageScreen.js';

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

  it('before the first broadcast arrives the screen renders without throwing', () => {
    const html = renderToStaticMarkup(React.createElement(UsageView, { table: null }));
    expect(html).toContain('No provider sessions yet');
  });
});
