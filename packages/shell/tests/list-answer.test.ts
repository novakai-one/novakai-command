// NVK-KIMI-091 B2.1 — the difference between "none" and "nobody said".
//
// B0 found this lie on the Runs screen: a list initialised to `null`, read as
// `?? []`, drawn as "No agent runs yet". Seat 1 wrote down the suspicion that
// Runs was not the only screen doing it. It was not — the audit found the same
// shape on FOUR: usage, notifications, watchers, agents. Every one of them told
// Chris there was nothing there while nothing had answered yet.
//
// It is the same defect as FZ-VIEW-010's "Unavailable is not zero", one level
// up: an absent ANSWER rendered as an answer of none. So it gets the same
// treatment the false zero got in B1.2 — not a rule each screen must remember,
// but a shape in which the lie has nowhere to live. `rows` and `none` are
// derived from a source that answered; with no source there is no row list to
// read, so `none` is unreachable rather than merely avoided.
import { describe, it, expect } from 'vitest';
import { answerFrom, type ListAnswer } from '../contract/listAnswer.js';

interface Page { readonly items: readonly string[] }

const answer = (
  source: Page | null | undefined,
  failure: { code: string; message: string } | null = null,
): ListAnswer<string> => answerFrom({
  source,
  failure,
  rowsOf: (page: Page) => page.items,
});

describe('what a list of nothing actually means', () => {
  it('nobody has answered yet — and that is not "none"', () => {
    expect(answer(null)).toEqual({ kind: 'waiting' });
    expect(answer(undefined)).toEqual({ kind: 'waiting' });
  });

  it('an authority answered, and the answer was none', () => {
    expect(answer({ items: [] })).toEqual({ kind: 'none' });
  });

  it('an authority answered with rows', () => {
    expect(answer({ items: ['a', 'b'] })).toEqual({ kind: 'rows', rows: ['a', 'b'] });
  });

  it('a failure outranks everything — a stale list must not read as fine', () => {
    const failure = { code: 'RuntimeUnavailable', message: 'no Runtime here' };
    expect(answer({ items: ['a'] }, failure)).toEqual({ kind: 'failed', failure });
    expect(answer(null, failure)).toEqual({ kind: 'failed', failure });
  });

  it('never reads the source when it is absent — the rows do not exist to read', () => {
    // The refusal is structural: `rowsOf` is the ONLY way to a row list, and it
    // cannot run without a source. A screen cannot accidentally reach past a
    // null and find an empty array.
    let asked = 0;
    answerFrom({
      source: null,
      failure: null,
      rowsOf: (page: Page) => { asked += 1; return page.items; },
    });
    expect(asked).toBe(0);
  });

  it('a `rows` answer always carries at least one row', () => {
    // The type says `[TRow, ...TRow[]]`; this pins the runtime half, so an
    // empty `rows` answer cannot slip past a cast.
    const given = answer({ items: [] });
    expect(given.kind).not.toBe('rows');
  });
});
