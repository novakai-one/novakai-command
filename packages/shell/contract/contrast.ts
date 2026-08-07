// shell/contract/contrast.ts — WCAG contrast arithmetic (SHL-009, R3-26).
// Single source of truth: kit tokens, the check-contrast tool, and set-time
// accent validation all compute from THESE definitions.

export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const chan = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan((n >> 16) & 0xff) + 0.7152 * chan((n >> 8) & 0xff) + 0.0722 * chan(n & 0xff);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Theme definitions (DESIGN-LAWS §16; elevation ramps one direction, 16a) ──
// Dark: rail #121214 → workspace #1b1b1e → inspector #252529 (ascending).
// Light: same law, ascending luminance rail → workspace → inspector.
export interface ThemeTokens {
  name: 'dark' | 'light';
  ground: string;
  rail: string;
  workspace: string;
  inspector: string;
  ink: string;   // tier 1 — primary text
  ink2: string;  // tier 2 — secondary text
  ink3: string;  // tier 3 — quiet text (floor: still ≥4.5:1 on its panel)
  accent: string;       // ONE signal (gold default)
  sage: string;         // resolved / presence-online liveness (never a signal)
  brand: string;        // wordmark amber — separate from accent (16b)
  danger: string;
}

export const DARK_THEME: ThemeTokens = {
  name: 'dark',
  ground: '#0d0d0f',
  rail: '#121214',
  workspace: '#1b1b1e',
  inspector: '#252529',
  ink: '#ececee',
  ink2: '#b4b4bb',
  ink3: '#8e8e97',
  accent: '#d0a14b',
  sage: '#78a886',
  brand: '#c98f2f',
  danger: '#cf7675',
};

export const LIGHT_THEME: ThemeTokens = {
  name: 'light',
  ground: '#d9d9dc',
  rail: '#e6e6e9',
  workspace: '#f2f2f4',
  inspector: '#fbfbfc',
  ink: '#1a1a1e',
  ink2: '#3f3f46',
  ink3: '#60606a',
  accent: '#8a6210',
  sage: '#2f6b4a',
  brand: '#8a6210',
  danger: '#9c3534',
};

export const THEMES: Record<'dark' | 'light', ThemeTokens> = { dark: DARK_THEME, light: LIGHT_THEME };

export const TEXT_FLOOR = 4.5;    // WCAG AA text
export const GRAPHIC_FLOOR = 3.0; // WCAG AA meaningful graphics

/** Every (foreground, background, floor) pair a theme must pass (18a: both themes). */
export function themePairs(t: ThemeTokens): { fg: string; bg: string; floor: number; label: string }[] {
  const pairs: { fg: string; bg: string; floor: number; label: string }[] = [];
  const panels: [string, string][] = [
    ['rail', t.rail],
    ['workspace', t.workspace],
    ['inspector', t.inspector],
  ];
  for (const [pname, phex] of panels) {
    pairs.push({ fg: t.ink, bg: phex, floor: TEXT_FLOOR, label: `${pname}/ink` });
    pairs.push({ fg: t.ink2, bg: phex, floor: TEXT_FLOOR, label: `${pname}/ink2` });
    pairs.push({ fg: t.ink3, bg: phex, floor: TEXT_FLOOR, label: `${pname}/ink3` });
    pairs.push({ fg: t.accent, bg: phex, floor: GRAPHIC_FLOOR, label: `${pname}/accent(graphic)` });
    pairs.push({ fg: t.sage, bg: phex, floor: GRAPHIC_FLOOR, label: `${pname}/sage(graphic)` });
  }
  // accent as text (it is used for the single signal label) — text floor on ground+workspace
  pairs.push({ fg: t.accent, bg: t.workspace, floor: TEXT_FLOOR, label: 'workspace/accent(text)' });
  pairs.push({ fg: t.brand, bg: t.rail, floor: GRAPHIC_FLOOR, label: 'rail/brand(wordmark)' });
  pairs.push({ fg: t.danger, bg: t.workspace, floor: TEXT_FLOOR, label: 'workspace/danger(text)' });
  return pairs;
}

export interface ContrastFailure { theme: string; label: string; ratio: number; floor: number }

export function auditTheme(t: ThemeTokens): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const p of themePairs(t)) {
    const ratio = contrastRatio(p.fg, p.bg);
    if (ratio < p.floor) failures.push({ theme: t.name, label: p.label, ratio, floor: p.floor });
  }
  return failures;
}

/** Set-time accent validation (R3-26): block sub-AA accents against all panels. */
export function accentPasses(accent: string, t: ThemeTokens): { ok: boolean; worstRatio: number } {
  let worst = Infinity;
  for (const bg of [t.rail, t.workspace, t.inspector]) {
    const r = contrastRatio(accent, bg);
    if (r < worst) worst = r;
  }
  return { ok: worst >= GRAPHIC_FLOOR, worstRatio: worst };
}
