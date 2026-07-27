// tests/settings.test.ts — settings key registry (§11 ruling 7), R3-22 model
// labelling, R3-26 set-time accent contrast blocking, round-trip persistence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateSetting, setSetting, getSettings, settingValue, renderSpeedKey } from '../contract/settings.js';
import { composeShellPersistence } from '../contract/persistence.node.js';

describe('settings key registry', () => {
  it('rejects unknown keys with a typed error naming the registry', () => {
    const res = validateSetting('nonsense.key', 1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('UnknownSettingKey');
      expect((res.error.details as { registered: string[] }).registered).toContain('theme');
    }
  });

  it('rejects out-of-range render speeds', () => {
    expect(validateSetting('renderSpeed.default', 5).ok).toBe(false);
    expect(validateSetting('renderSpeed.default', 5000).ok).toBe(false);
    expect(validateSetting('renderSpeed.default', 240).ok).toBe(true);
  });

  it('validates per-conversation speed keys by prefix', () => {
    expect(validateSetting(renderSpeedKey('conv_abc'), 120).ok).toBe(true);
    expect(validateSetting('renderSpeed.', 120).ok).toBe(false);
  });

  it('blocks sub-AA accents at set time (R3-26, ContrastBlocked)', () => {
    const res = validateSetting('accent', '#555555', { theme: 'dark' }); // mud grey on dark ground
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('ContrastBlocked');
      expect(res.error.retryable).toBe(false);
    }
    expect(validateSetting('accent', '#d0a14b', { theme: 'dark' }).ok).toBe(true);
  });

  it('rejects model keys without a derivedFrom label (R3-22)', () => {
    const res = validateSetting('lastUsedModel', 'kimi-k2');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('InvalidSettingValue');
    expect(validateSetting('lastUsedModel', 'kimi-k2', { derivedFrom: 'agents.setModel' }).ok).toBe(true);
  });

  it('rejects malformed values with reasons', () => {
    expect(validateSetting('theme', 'blue').ok).toBe(false);
    expect(validateSetting('accent', 'gold').ok).toBe(false);
    expect(validateSetting('density', 'spacious').ok).toBe(false);
  });
});

describe('settings persistence round-trip (foundation-backed)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'nvk-shell-settings-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('setSetting → fresh composition reads it back (last good wins)', async () => {
    const a = composeShellPersistence({ root, principal: 'person_test' });
    const r1 = await setSetting(a.settingsDriver, 'theme', 'light');
    expect(r1.ok).toBe(true);
    await setSetting(a.settingsDriver, 'renderSpeed.default', 480);
    await setSetting(a.settingsDriver, 'lastUsedModel', 'kimi-k2', { derivedFrom: 'agents.setModel' });

    const b = composeShellPersistence({ root, principal: 'person_test' });
    const records = await getSettings(b.settingsDriver);
    expect(settingValue<string>(records, 'theme')).toBe('light');
    expect(settingValue<number>(records, 'renderSpeed.default')).toBe(480);
    expect(settingValue<string>(records, 'lastUsedModel')).toBe('kimi-k2');
    const model = records.find((r) => r.key === 'lastUsedModel');
    expect(model?.derivedFrom).toBe('agents.setModel');
  });

  it('validation fires before any write reaches the store', async () => {
    const a = composeShellPersistence({ root, principal: 'person_test' });
    const bad = await setSetting(a.settingsDriver, 'unknown.key', 1);
    expect(bad.ok).toBe(false);
    const records = await getSettings(a.settingsDriver);
    expect(records.find((r) => r.key === 'unknown.key')).toBeUndefined();
  });
});
