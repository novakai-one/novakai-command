// tests/renderer.test.ts — SHL-007 / DEC-S7 / R3-27: user-set speed, bounded
// buffer, flush-oldest with a drawn gap marker.
import { describe, it, expect } from 'vitest';
import { ThreadRenderer, countTokens, DEFAULT_BUFFER_CAP_TOKENS } from '../contract/renderer.js';

describe('thread renderer speed control', () => {
  it('renders proportionally to the set speed', () => {
    const slow = new ThreadRenderer({ speed: 100 });
    const fast = new ThreadRenderer({ speed: 800 });
    slow.feed('x'.repeat(4000)); // ~1000 tokens
    fast.feed('x'.repeat(4000));
    const slowOut = slow.tick(1000).text.length;
    const fastOut = fast.tick(1000).text.length;
    expect(fastOut).toBeGreaterThan(slowOut * 4);
  });

  it('a speed change applies to the UNRENDERED backlog immediately', () => {
    const r = new ThreadRenderer({ speed: 10 });
    r.feed('x'.repeat(4000));
    const before = r.tick(1000).text.length; // slow: ~40 chars
    r.setSpeed(2000);
    const after = r.tick(1000).text.length; // fast: the rest pours out
    expect(before).toBeLessThan(80);
    expect(after).toBeGreaterThan(1000);
  });

  it('empty tick produces nothing; backlog never goes negative', () => {
    const r = new ThreadRenderer({ speed: 100 });
    expect(r.tick(100).text).toBe('');
    r.feed('hello world');
    r.flushAll();
    expect(r.tick(1000).text).toBe('');
    expect(r.snapshot().backlogTokens).toBe(0);
  });
});

describe('bounded buffer + gap marker (R3-27)', () => {
  it('flushes OLDEST content at the cap and marks a gap', () => {
    const r = new ThreadRenderer({ speed: 1000, capTokens: 10 }); // 40 chars
    r.feed('A'.repeat(40));
    expect(r.snapshot().backlogTokens).toBeLessThanOrEqual(10);
    expect(r.snapshot().gapCount).toBe(0); // exactly at cap — no flush yet
    r.feed('B'.repeat(40)); // now 80 chars against a 40-char cap
    const snap = r.snapshot();
    expect(snap.backlogTokens).toBeLessThanOrEqual(10);
    expect(snap.gapCount).toBeGreaterThan(0);
    const chunk = r.tick(1000);
    expect(chunk.gapBefore).toBe(true); // the renderer draws "…" first
    // oldest ('A's) were flushed — what remains is the newest
    expect(chunk.text).not.toContain('A');
  });

  it('default cap is the spec constant (10k tokens)', () => {
    expect(DEFAULT_BUFFER_CAP_TOKENS).toBe(10_000);
    const r = new ThreadRenderer();
    r.feed('x'.repeat(4 * 9_000)); // 9k tokens — under cap
    expect(r.snapshot().gapCount).toBe(0);
    r.feed('x'.repeat(4 * 2_000)); // 11k total — over cap
    expect(r.snapshot().backlogTokens).toBeLessThanOrEqual(DEFAULT_BUFFER_CAP_TOKENS);
    expect(r.snapshot().gapCount).toBe(1);
  });

  it('discard clears backlog and gaps (closing a chat)', () => {
    const r = new ThreadRenderer({ capTokens: 5 });
    r.feed('x'.repeat(1000));
    r.discard();
    const s = r.snapshot();
    expect(s.backlogTokens).toBe(0);
    expect(s.gapCount).toBe(0);
    expect(s.rendered).toBe('');
  });

  it('token counter is deterministic', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('abcd')).toBe(1);
    expect(countTokens('abcde')).toBe(2);
  });
});
