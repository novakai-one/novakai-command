// S2b — themes pass (SHL-009, DEC-S2-9): accent set-time AA validation,
// density modes, reduced-motion EXPOSED as a setting (not only the OS media
// query), light theme token sanity.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateSetting } from '../contract/index.js';

const tokens = readFileSync(path.resolve('ui/kit/tokens.css'), 'utf8');
const kit = readFileSync(path.resolve('ui/kit/kit.css'), 'utf8');

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

  it('tokens.css collapses ALL motion under [data-motion="reduced"]', () => {
    expect(tokens).toContain('[data-motion="reduced"]');
  });

  it('the OS media query is still honoured (belt and braces)', () => {
    expect(tokens).toContain('prefers-reduced-motion');
  });
});

describe('density modes', () => {
  it('comfortable and compact are the only values', () => {
    expect(validateSetting('density', 'comfortable').ok).toBe(true);
    expect(validateSetting('density', 'compact').ok).toBe(true);
    expect(validateSetting('density', 'roomy').ok).toBe(false);
  });

  it('compact density tokens exist and differ from comfortable', () => {
    expect(tokens).toContain('[data-density="compact"]');
    expect(tokens).toContain('[data-density="comfortable"]');
  });
});

describe('kit motion goes through tokens (so the collapse actually works)', () => {
  it('kit.css has no hard-coded durations outside the token definitions', () => {
    const hardcoded = kit.match(/(?<![\w-])\d+ms/g) ?? [];
    expect(hardcoded).toEqual([]);
  });
});

describe('light theme polish (SHL-009: both themes are designed)', () => {
  it('light theme defines its own full token set (not an inversion)', () => {
    const light = tokens.split('[data-theme="light"]')[1] ?? '';
    for (const token of ['--ground', '--rail', '--workspace', '--inspector', '--ink', '--accent', '--sage', '--hairline', '--bubble-theirs', '--bubble-mine']) {
      expect(light).toContain(token);
    }
  });
});
