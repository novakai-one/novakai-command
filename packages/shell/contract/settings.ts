// shell/contract/settings.ts — settings key registry (§11 ruling 7: shell owns
// the registry; unknown keys rejected) + get/set over a pluggable driver.
// Node composition wires the foundation-backed driver; the browser demo wires
// the bridge driver. Same validation both paths.
import { z } from 'zod';
import type { SettingsRecord } from './types.js';
import { THEMES, accentPasses, contrastRatio, GRAPHIC_FLOOR } from './contrast.js';
import {
  invalidSettingValue, unknownSettingKey, contrastBlocked, ok, fail,
  type Result,
  type ContrastBlockedError, type InvalidSettingValueError, type PersistFailedError, type UnknownSettingKeyError,
} from './errors.js';

export type SetSettingError = UnknownSettingKeyError | InvalidSettingValueError | ContrastBlockedError | PersistFailedError;

// ── Key registry ────────────────────────────────────────────────────────────
interface KeyRule {
  pattern: RegExp;
  validate(value: unknown): string | null; // null = valid, else reason
  /** R3-22: model-related keys are last-used UI defaults only, derived-labelled. */
  requiresDerivedFrom?: boolean;
}

const speedRule: KeyRule = {
  pattern: /^renderSpeed\.(default|conv_[A-Za-z0-9-]+)$/,
  validate(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'renderSpeed must be a finite number';
    if (v < 10 || v > 2000) return 'renderSpeed must be between 10 and 2000 tokens/sec';
    return null;
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export const SETTING_KEYS: Record<string, KeyRule> = {
  theme: {
    pattern: /^theme$/,
    validate: (v) => (v === 'dark' || v === 'light' ? null : 'theme must be "dark" or "light"'),
  },
  accent: {
    pattern: /^accent$/,
    validate: (v) => (typeof v === 'string' && HEX.test(v) ? null : 'accent must be a #rrggbb hex colour'),
  },
  bubbleStyle: {
    pattern: /^bubbleStyle$/,
    validate: (v) => (v === 'bubbles' || v === 'minimal' ? null : 'bubbleStyle must be "bubbles" or "minimal"'),
  },
  density: {
    pattern: /^density$/,
    validate: (v) => (v === 'comfortable' || v === 'compact' ? null : 'density must be "comfortable" or "compact"'),
  },
  // DEC-S2-9: reduced-motion is an EXPOSED setting, not only the OS media query.
  motion: {
    pattern: /^motion$/,
    validate: (v) => (v === 'full' || v === 'reduced' ? null : 'motion must be "full" or "reduced"'),
  },
  'renderSpeed.default': speedRule,
  lastUsedModel: {
    pattern: /^lastUsedModel$/,
    validate: (v) => (typeof v === 'string' && v.length > 0 ? null : 'lastUsedModel must be a non-empty string'),
    requiresDerivedFrom: true, // R3-22: no model truth in shell — derived-labelled only
  },
};

function ruleFor(key: string): KeyRule | null {
  if (SETTING_KEYS[key]) return SETTING_KEYS[key];
  if (speedRule.pattern.test(key)) return speedRule; // renderSpeed.<conversationId>
  return null;
}

export function registeredSettingKeys(): string[] {
  return [...Object.keys(SETTING_KEYS), 'renderSpeed.<conversationId>'];
}

// ── Validation (pure — unit-tested without a store) ─────────────────────────
export function validateSetting(
  key: string,
  value: unknown,
  opts: { derivedFrom?: string; theme?: 'dark' | 'light'; currentAccent?: string } = {},
): Result<true, SetSettingError> {
  const rule = ruleFor(key);
  if (!rule) return fail(unknownSettingKey(key, registeredSettingKeys()));
  const reason = rule.validate(value);
  if (reason) return fail(invalidSettingValue(key, reason));
  if (rule.requiresDerivedFrom && !opts.derivedFrom) {
    return fail(invalidSettingValue(key, 'model-related keys must carry derivedFrom (R3-22: settings hold last-used UI defaults only)'));
  }
  if (key === 'accent' && typeof value === 'string') {
    const theme = THEMES[opts.theme ?? 'dark'];
    // R3-26: set-time validation blocks sub-AA accents. Text floor when the
    // accent is used as text, graphics floor otherwise — we require the
    // stricter text floor on the workspace, graphics floor elsewhere.
    const textRatio = contrastRatio(value, theme.workspace);
    if (textRatio < 4.5) return fail(contrastBlocked(value, textRatio, 4.5));
    const g = accentPasses(value, theme);
    if (!g.ok) return fail(contrastBlocked(value, g.worstRatio, GRAPHIC_FLOOR));
  }
  return ok(true);
}

// ── Driver seam (foundation-backed in node; bridge-backed in browser) ───────
export interface SettingsDriver {
  readAll(): Promise<SettingsRecord[]>;
  write(record: { key: string; value: unknown; derivedFrom?: string }, clientOpId: string): Promise<Result<SettingsRecord, PersistFailedError>>;
}

export async function getSettings(driver: SettingsDriver): Promise<SettingsRecord[]> {
  return driver.readAll();
}

export async function setSetting(
  driver: SettingsDriver,
  key: string,
  value: unknown,
  // M5/DEC-S2-12: clientOpId is REQUIRED (generated at the interaction layer,
  // threaded to foundation meta — R3-10 dedup covers UI retries).
  opts: { derivedFrom?: string; theme?: 'dark' | 'light'; clientOpId: string },
): Promise<Result<SettingsRecord, SetSettingError>> {
  const v = validateSetting(key, value, opts);
  if (!v.ok) return fail(v.error);
  const written = await driver.write({ key, value, derivedFrom: opts.derivedFrom }, opts.clientOpId);
  if (!written.ok) return fail(written.error); // M4: typed store failure, never a throw
  return ok(written.value);
}

/** Convenience: current value of one key from a record list (last line wins). */
export function settingValue<T>(records: SettingsRecord[], key: string): T | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].key === key) return records[i].value as T;
  }
  return undefined;
}

export const renderSpeedKey = (conversationId: string) => `renderSpeed.${conversationId}`;
export const RenderSpeedValue = z.number().min(10).max(2000);
export const DEFAULT_RENDER_SPEED = 240; // tokens/sec, calm default
