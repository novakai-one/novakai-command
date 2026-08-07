// tests/mount.test.ts — SHL-001 / DEC-S9 / R3-19: dynamic-import mounting;
// absent app packages leave no ghosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  bootApps, mountedApps, screenFor, registerApp, registerScreen,
  parseScreenPayload, __resetMountRegistry,
} from '../contract/mount.js';
import { z } from 'zod';

beforeEach(() => __resetMountRegistry());

describe('mount registry', () => {
  it('registers apps and resolves screens by kind', () => {
    registerApp('messaging', { appId: 'messaging', label: 'Messages' });
    registerScreen('conversation', 'messaging-thread');
    expect(mountedApps().map((a) => a.appId)).toEqual(['messaging']);
    expect(screenFor('conversation')?.screenId).toBe('messaging-thread');
    expect(screenFor('nonexistent')).toBeNull();
  });

  it('boot with an absent app package: failed import = not registered = no ghost (SHL-001)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nvk-mount-'));
    const goodPath = path.join(dir, 'good-app.mjs');
    writeFileSync(goodPath, `
      export const appId = 'good';
      export function mount(reg) {
        reg.registerApp('good', { appId: 'good', label: 'Good app' });
        reg.registerScreen('thing', 'good-thing');
      }
    `);
    const mounted = await bootApps([
      { appId: 'good', importPath: goodPath },
      { appId: 'ghost', importPath: path.join(dir, 'does-not-exist.mjs') }, // absent package
    ]);
    expect(mounted).toEqual(['good']);
    const apps = mountedApps();
    expect(apps.map((a) => a.appId)).toEqual(['good']);
    expect(apps.find((a) => a.appId === 'ghost')).toBeUndefined(); // no ghost rail entry
    expect(screenFor('ghost-kind')).toBeNull();
  });

  it('screen payloads parse through zod at the seam (R3-12) — junk never renders', () => {
    registerScreen('conversation', 'thread', z.object({ id: z.string() }));
    expect(parseScreenPayload('conversation', { id: 'conv_1' })).toEqual({ id: 'conv_1' });
    expect(() => parseScreenPayload('conversation', { nope: true })).toThrow();
  });
});
