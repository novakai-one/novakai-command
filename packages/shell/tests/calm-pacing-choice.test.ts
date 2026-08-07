// NVK-KIMI-091 — the Calm pacing PICKER's half of the rule (FZ-VIEW-017).
//
// `CALM_PACING_LIMITS` was exported in B1.1 precisely so a picker and the
// record's validator could not disagree. This is the reading half: a typed
// string in, a number the record will accept or a refusal that says why.
//
// The refusals matter more than the acceptances here. A picker that CLAMPS
// silently is a control that disagrees with the thing it controls — Chris types
// 5,000,000 and the tab quietly runs at 2,000, so the number on screen is not
// the number in force. A picker that drops the write on the floor is worse: the
// value looks set and is not. Both are stated refusals instead.
import { describe, it, expect } from 'vitest';
import { readPacingChoice } from '../contract/calmPacing.js';
import { CALM_PACING_LIMITS } from '../contract/terminalTab.js';

const accepted = (field: Parameters<typeof readPacingChoice>[0], raw: string): number => {
  const read = readPacingChoice(field, raw);
  if (!read.accepted) throw new Error(`"${raw}" was refused: ${read.because}`);
  return read.value;
};
const refused = (field: Parameters<typeof readPacingChoice>[0], raw: string): string => {
  const read = readPacingChoice(field, raw);
  if (read.accepted) throw new Error(`"${raw}" was accepted as ${read.value}`);
  return read.because;
};

describe('a value the record will take', () => {
  it('reads a plain number', () => {
    expect(accepted('revealLinesPerSecond', '24')).toBe(24);
    expect(accepted('maxBufferedLines', '2000')).toBe(2_000);
  });

  it('takes both ends of the range — a floor you cannot pick is not a floor', () => {
    for (const [field, limit] of Object.entries(CALM_PACING_LIMITS)) {
      const named = field as Parameters<typeof readPacingChoice>[0];
      expect(accepted(named, String(limit.floor))).toBe(limit.floor);
      expect(accepted(named, String(limit.ceiling))).toBe(limit.ceiling);
    }
  });

  it('ignores the spaces a person leaves around a number', () => {
    expect(accepted('revealLinesPerSecond', ' 30 ')).toBe(30);
  });
});

describe('a value the record would refuse is refused HERE, with a reason', () => {
  it('nothing typed at all', () => {
    expect(refused('revealLinesPerSecond', '')).toMatch(/number/iu);
  });

  it('not a number', () => {
    expect(refused('revealLinesPerSecond', 'fast')).toMatch(/number/iu);
  });

  it('a fraction — the record stores whole lines', () => {
    expect(refused('revealLinesPerSecond', '12.5')).toMatch(/whole/iu);
  });

  it('below the floor, and the reason says what the floor is FOR', () => {
    const because = refused('revealLinesPerSecond', '0');
    expect(because).toContain('1');
    expect(because).toMatch(/hung|never reveal/iu);
  });

  it('a zero buffer is refused for the same reason, not accepted as "no buffer"', () => {
    expect(refused('maxBufferedLines', '0')).toContain('100');
  });

  it('above the ceiling, named rather than clamped', () => {
    const because = refused('revealLinesPerSecond', '5000000');
    expect(because).toContain('2,000');
  });

  it('never returns a value outside the range it just refused', () => {
    // The clamp that must not exist: every refusal carries NO value at all.
    for (const raw of ['0', '-4', '5000000', '', 'fast', '1e9']) {
      const read = readPacingChoice('revealLinesPerSecond', raw);
      expect(read.accepted).toBe(false);
    }
  });

  it('a refusal is never blank — red gate 5', () => {
    for (const raw of ['', 'fast', '0', '99999999']) {
      expect(refused('maxBufferedLines', raw).trim().length).toBeGreaterThan(10);
    }
  });
});
