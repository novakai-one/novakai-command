// shell/contract/persistence.node.ts — NODE-ONLY composition: binds the shell
// layout/settings drivers to packages/foundation's store contract (R3-7:
// writes go through the foundation contract only — enveloped, traced,
// CAS-guarded; no shell-private write path). Browser code never imports this.
import { randomUUID } from 'node:crypto';
import {
  composeHandle, createObject, updateObject, getObject, listObjects,
  type ScopedStoreHandle, type ObjectId, type ClientOpId,
} from '../../foundation/dist/contract/index.js';

import { LAYOUT_MAIN_ID, LayoutRecord, SettingsRecord } from './types.js';
import type { LayoutDriver } from './layout.js';
import type { SettingsDriver } from './settings.js';
import { fail, ok, persistFailed } from './errors.js';

export interface ShellPersistence {
  handle: ScopedStoreHandle;
  layoutDriver: LayoutDriver;
  settingsDriver: SettingsDriver;
}

const clientOpId = () => `op_${randomUUID()}` as unknown as ClientOpId;

export function composeShellPersistence(opts: {
  root: string;
  legacyRoot?: string;
  principal: string;
  lockTimeoutMs?: number;
  /** @internal test seam: injected object-append failure (M4 typed-error tests). */
  failNextObjectAppend?: { cause: string };
}): ShellPersistence {
  const handle = composeHandle({
    root: opts.root,
    legacyRoot: opts.legacyRoot,
    capability: 'shell',
    allowedKinds: ['layout', 'settings'],
    principal: opts.principal,
    lockTimeoutMs: opts.lockTimeoutMs,
    ...(opts.failNextObjectAppend ? { failNextObjectAppend: opts.failNextObjectAppend } : {}),
  });

  const layoutDriver: LayoutDriver = {
    async read() {
      const res = await getObject<LayoutRecord>(handle, 'layout', LAYOUT_MAIN_ID as unknown as ObjectId);
      if (!res.ok || 'absent' in res.value) return null;
      const parsed = LayoutRecord.safeParse(res.value.object);
      if (!parsed.success) return null; // corrupt → treated as absent; store layer traces it
      return { record: parsed.data, version: res.value.version };
    },
    async write(patch, expectedVersion) {
      // M4: store failures are typed PersistFailed Results, never raw throws.
      if (expectedVersion === 0) {
        const res = await createObject<LayoutRecord>(handle, patch as LayoutRecord, clientOpId());
        if (!res.ok) return fail(persistFailed('layout', res.error.code, res.error.message));
        return ok({ record: res.value.object as LayoutRecord, version: res.value.version });
      }
      const res = await updateObject<LayoutRecord>(handle, LAYOUT_MAIN_ID as unknown as ObjectId, patch, expectedVersion, clientOpId());
      if (!res.ok) return fail(persistFailed('layout', res.error.code, res.error.message));
      return ok({ record: res.value.object as LayoutRecord, version: res.value.version });
    },
  };

  const settingsDriver: SettingsDriver = {
    async readAll() {
      const res = await listObjects<SettingsRecord>(handle, 'settings');
      if (!res.ok) return [];
      const out: SettingsRecord[] = [];
      for (const item of res.value.items) {
        const parsed = SettingsRecord.safeParse(item.object);
        if (parsed.success) out.push(parsed.data); // "last good" — corrupt lines skipped
      }
      return out;
    },
    async write({ key, value, derivedFrom }) {
      const record: SettingsRecord = {
        kind: 'settings',
        id: `settings_${key.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        permissionLevel: 'private',
        createdBy: opts.principal, // overridden by the engine from the token principal (red gate 4)
        key,
        value,
        ...(derivedFrom ? { derivedFrom } : {}),
      };
      const existing = await getObject<SettingsRecord>(handle, 'settings', record.id as unknown as ObjectId);
      if (existing.ok && !('absent' in existing.value)) {
        const res = await updateObject<SettingsRecord>(handle, record.id as unknown as ObjectId, record, existing.value.version, clientOpId());
        if (!res.ok) return fail(persistFailed('settings', res.error.code, res.error.message));
        return ok(res.value.object as SettingsRecord);
      }
      const res = await createObject<SettingsRecord>(handle, record, clientOpId());
      if (!res.ok) return fail(persistFailed('settings', res.error.code, res.error.message));
      return ok(res.value.object as SettingsRecord);
    },
  };

  return { handle, layoutDriver, settingsDriver };
}
