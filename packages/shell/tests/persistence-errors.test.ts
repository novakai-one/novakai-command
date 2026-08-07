// M4 — shell contract seam: store write failures are typed Result values
// (PersistFailed), never `throw new Error` rejections a consumer must catch.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeShellPersistence } from '../contract/persistence.node.js';
import { setLayout } from '../contract/layout.js';
import { setSetting } from '../contract/settings.js';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'nvk-shell-m4-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('M4: typed persistence failures (no raw throws)', () => {
  it('layout write failure → typed PersistFailed Result', async () => {
    const p = composeShellPersistence({
      root, principal: 'person_test', failNextObjectAppend: { cause: 'ENOSPC: no space left on device' },
    });
    const res = await setLayout(p.layoutDriver, { composer: { height: 200 } }, 'op_test_layout_fail');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('PersistFailed');
      expect(res.error.retryable).toBe(true);
    }
  });

  it('settings write failure → typed PersistFailed Result', async () => {
    const p = composeShellPersistence({
      root, principal: 'person_test', failNextObjectAppend: { cause: 'EIO: i/o error' },
    });
    const res = await setSetting(p.settingsDriver, 'theme', 'light', { clientOpId: 'op_test_settings_fail' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('PersistFailed');
  });

  it('healthy path still commits (no regression on the Result shape)', async () => {
    const p = composeShellPersistence({ root, principal: 'person_test' });
    const res = await setLayout(p.layoutDriver, { composer: { height: 210 } }, 'op_test_layout_ok');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.record.composer.height).toBe(210);
  });
});
