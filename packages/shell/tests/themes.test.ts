// S2b — settings-contract pass (DEC-S2-9): motion + density remain validated
// settings. The old two-theme kit token file was superseded by the sandbox
// design system (2026-08-21, Chris) — dark-only, one density — so the
// token-file assertions left with ui/kit/tokens.css; the setting VALUES stay
// valid so stored settings keep round-tripping.
import { describe, it, expect } from 'vitest';
import { validateSetting } from '../contract/index.js';

describe('motion setting (DEC-S2-9: reduced-motion is an exposed setting)', () => {
  it('accepts full and reduced', () => {
    expect(validateSetting('motion', 'full').ok).toBe(true);
    expect(validateSetting('motion', 'reduced').ok).toBe(true);
  });

  it('rejects anything else with a typed reason', () => {
    const res = validateSetting('motion', 'spicy');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('InvalidSettingValue');
  });
});

describe('density modes', () => {
  it('comfortable and compact are the only values', () => {
    expect(validateSetting('density', 'comfortable').ok).toBe(true);
    expect(validateSetting('density', 'compact').ok).toBe(true);
    expect(validateSetting('density', 'roomy').ok).toBe(false);
  });
});
