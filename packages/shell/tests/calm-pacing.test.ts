// B1.3 — Calm mode, the half a terminal can get catastrophically wrong.
//
// `TerminalTabRecord.mode` and `calmPacing` have been persisted and validated
// since B1.1, and until this slice NOTHING READ THEM: a tab saved as `calm`
// behaved byte-for-byte like a `raw` one. The record was true and the screen
// ignored it.
//
// The laws a paced terminal must not break, in the order they would hurt:
//
//   1. RAW IS IDENTITY. Every byte, immediately, in order. FZ-VIEW-032 has Raw
//      passing provider-native input through unchanged; a Raw that buffered
//      would be a Raw that lies about what the process printed.
//   2. A TERMINAL THAT IS FINE MUST NEVER LOOK HUNG. A shell prompt carries no
//      newline. An engine that holds partial lines until they complete holds
//      every prompt forever, and "the pacing is working" is indistinguishable
//      from "the process died".
//   3. DROPPED OUTPUT IS ANNOUNCED. The buffer has a ceiling, so output CAN be
//      lost. Losing it silently is the false empty wearing a terminal's
//      clothes — the same law `writeReplay`'s gap marker already obeys.
//   4. ASKING FOR THE TRUTH GIVES IT TO YOU NOW. Switching Calm → Raw flushes
//      everything held, in one go.
import { describe, it, expect } from 'vitest';
import {
  emptyCalmState, flushCalm, receiveCalm, revealCalm, rawPassthrough,
  type CalmPacing,
} from '../contract/calmPacing.js';

const PACING: CalmPacing = { maxBufferedLines: 100, revealLinesPerSecond: 10 };
const lines = (count: number, from = 1) => Array.from(
  { length: count }, (_unused, index) => `line ${index + from}\r\n`,
).join('');

describe('Raw is identity — the mode that cannot lie about what was printed', () => {
  it('returns exactly what it was handed', () => {
    expect(rawPassthrough('[31mred[0m no newline')).toBe('[31mred[0m no newline');
    expect(rawPassthrough('')).toBe('');
  });
});

describe('Calm releases at the rate it was given', () => {
  it('reveals nothing before any time has passed', () => {
    const state = receiveCalm(emptyCalmState(1_000), lines(50), PACING);
    const { text } = revealCalm(state, 1_000, PACING);
    expect(text).toBe('');
  });

  it('reveals ten lines after one second at ten lines per second', () => {
    const state = receiveCalm(emptyCalmState(1_000), lines(50), PACING);
    const { text } = revealCalm(state, 2_000, PACING);
    expect(text.match(/line \d+/g) ?? []).toHaveLength(10);
    expect(text).toContain('line 1');
    expect(text).toContain('line 10');
    expect(text).not.toContain('line 11');
  });

  it('keeps the fractional remainder, so a slow rate still moves on a fast tick', () => {
    // 1 line/sec against a 100ms tick: nine ticks earn nothing, the tenth earns
    // the line. An engine that floored and discarded the remainder would reveal
    // NOTHING, ever, at any rate below one line per tick.
    const slow: CalmPacing = { maxBufferedLines: 100, revealLinesPerSecond: 1 };
    let state = receiveCalm(emptyCalmState(0), lines(5), slow);
    let seen = '';
    for (let tick = 1; tick <= 10; tick += 1) {
      const step = revealCalm(state, tick * 100, slow);
      state = step.state;
      seen += step.text;
    }
    expect(seen.match(/line \d+/g) ?? []).toHaveLength(1);
  });

  it('preserves order across many reveals', () => {
    let state = receiveCalm(emptyCalmState(0), lines(30), PACING);
    let seen = '';
    for (let second = 1; second <= 3; second += 1) {
      const step = revealCalm(state, second * 1_000, PACING);
      state = step.state;
      seen += step.text;
    }
    const order = (seen.match(/line (\d+)/g) ?? []).map((hit) => Number(hit.slice(5)));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order).toHaveLength(30);
  });
});

describe('a terminal that is fine never looks hung', () => {
  it('releases a trailing partial line once the backlog has drained', () => {
    // The prompt case. `$ ` has no newline and never will until Chris types.
    const state = receiveCalm(emptyCalmState(0), 'done\r\nchris@novakai $ ', PACING);
    const { text } = revealCalm(state, 10_000, PACING);
    expect(text).toContain('done');
    expect(text).toContain('chris@novakai $ ');
  });

  it('does NOT release the partial line while whole lines are still queued', () => {
    // Releasing the tail early would print the prompt above the output it
    // belongs under — the pacing would be reordering the screen.
    const state = receiveCalm(emptyCalmState(0), `${lines(50)}chris@novakai $ `, PACING);
    const { text } = revealCalm(state, 1_000, PACING);
    expect(text).not.toContain('chris@novakai $');
  });

  it('completes a partial line when the rest of it arrives', () => {
    let state = receiveCalm(emptyCalmState(0), 'half a ', PACING);
    state = receiveCalm(state, 'line\r\n', PACING);
    const { text } = revealCalm(state, 10_000, PACING);
    expect(text).toContain('half a line');
  });
});

describe('output that was dropped is said out loud', () => {
  const tight: CalmPacing = { maxBufferedLines: 10, revealLinesPerSecond: 10 };

  it('keeps the most recent lines, not the oldest — a terminal shows you now', () => {
    const state = receiveCalm(emptyCalmState(0), lines(30), tight);
    const { text } = revealCalm(state, 10_000, tight);
    expect(text).toContain('line 30');
    expect(text).not.toContain('line 1\r\n');
  });

  it('announces the gap rather than swallowing it', () => {
    const state = receiveCalm(emptyCalmState(0), lines(30), tight);
    const { text } = revealCalm(state, 10_000, tight);
    expect(text).toMatch(/20 line/);
    expect(text).toMatch(/not shown/i);
  });

  it('announces each gap once, not on every reveal after it', () => {
    let state = receiveCalm(emptyCalmState(0), lines(30), tight);
    let seen = '';
    for (let tick = 1; tick <= 5; tick += 1) {
      const step = revealCalm(state, tick * 1_000, tight);
      state = step.state;
      seen += step.text;
    }
    expect(seen.match(/not shown/gi) ?? []).toHaveLength(1);
  });

  it('says nothing at all when nothing was dropped', () => {
    const state = receiveCalm(emptyCalmState(0), lines(5), PACING);
    const { text } = revealCalm(state, 10_000, PACING);
    expect(text).not.toMatch(/not shown/i);
  });
});

describe('asking for the truth gives it to you now', () => {
  it('flushes everything held, in order, in one go', () => {
    const state = receiveCalm(emptyCalmState(0), `${lines(40)}tail`, PACING);
    const { text } = flushCalm(state);
    expect(text.match(/line \d+/g) ?? []).toHaveLength(40);
    expect(text).toContain('tail');
  });

  it('leaves nothing behind — a second flush is empty', () => {
    const first = flushCalm(receiveCalm(emptyCalmState(0), lines(10), PACING));
    expect(flushCalm(first.state).text).toBe('');
  });

  it('still announces a gap it was holding when the flush happens', () => {
    const tight: CalmPacing = { maxBufferedLines: 5, revealLinesPerSecond: 10 };
    const state = receiveCalm(emptyCalmState(0), lines(20), tight);
    expect(flushCalm(state).text).toMatch(/not shown/i);
  });
});

describe('the engine holds no more than it was told to', () => {
  it('never buffers past maxBufferedLines however much arrives', () => {
    const tight: CalmPacing = { maxBufferedLines: 10, revealLinesPerSecond: 1 };
    let state = emptyCalmState(0);
    for (let burst = 0; burst < 20; burst += 1) {
      state = receiveCalm(state, lines(50, burst * 50 + 1), tight);
    }
    expect(state.pending.length).toBeLessThanOrEqual(10);
  });

  it('is a value, not a mutation — receiving does not alter what it was handed', () => {
    const before = receiveCalm(emptyCalmState(0), lines(3), PACING);
    const pendingBefore = [...before.pending];
    receiveCalm(before, lines(3, 4), PACING);
    expect([...before.pending]).toEqual(pendingBefore);
  });
});
