// tests/contrast.test.ts — SHL-009: computed contrast, BOTH themes, plus
// elevation law (16a: luminance ascends rail → workspace → inspector).
import { describe, it, expect } from 'vitest';
import {
  THEMES, auditTheme, contrastRatio, relativeLuminance,
} from '../contract/contrast.js';

describe('contrast gate (SHL-009)', () => {
  it('dark theme: every ink/ground/accent pair reaches AA', () => {
    expect(auditTheme(THEMES.dark)).toEqual([]);
  });

  it('light theme: every ink/ground/accent pair reaches AA (18a — arithmetic, not assumption)', () => {
    expect(auditTheme(THEMES.light)).toEqual([]);
  });

  it('elevation ramps one direction in both themes (law 16a)', () => {
    for (const t of Object.values(THEMES)) {
      const rail = relativeLuminance(t.rail);
      const ws = relativeLuminance(t.workspace);
      const insp = relativeLuminance(t.inspector);
      expect(ws).toBeGreaterThan(rail);
      expect(insp).toBeGreaterThan(ws);
    }
  });

  it('ratio math sanity: white on black is 21:1, identical colours 1:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#1b1b1e', '#1b1b1e')).toBeCloseTo(1, 5);
  });

  it('liveness tokens are NOT the accent token (R3-25)', () => {
    for (const t of Object.values(THEMES)) {
      expect(t.sage).not.toBe(t.accent);
    }
  });
});
