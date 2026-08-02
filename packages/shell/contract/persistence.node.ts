// shell/contract/persistence.node.ts — NODE-ONLY composition: binds the shell
// layout/settings drivers to packages/foundation's store contract (R3-7:
// writes go through the foundation contract only — enveloped, traced,
// CAS-guarded; no shell-private write path). Browser code never imports this.
import {
  composeHandle, createObject, updateObject, getObject, listObjects,
  type ScopedStoreHandle, type ObjectId, type ClientOpId,
} from '../../foundation/dist/contract/index.js';

import { LAYOUT_MAIN_ID, LayoutRecord, SettingsRecord } from './types.js';
import type { LayoutDriver } from './layout.js';
import type { SettingsDriver } from './settings.js';
import { ConversationViewRecord, type ConversationViewDriver } from './conversationView.js';
import { fail, ok, persistFailed } from './errors.js';

export interface ShellPersistence {
  handle: ScopedStoreHandle;
  layoutDriver: LayoutDriver;
  settingsDriver: SettingsDriver;
  conversationViewDriver: ConversationViewDriver;
}

export function composeShellPersistence(opts: {
  root: string;
  /**
   * The canonical JSONL directory (§18.1). Callers that pass it get
   * `<dataRoot>/conversationViews.jsonl`; callers that do not keep the
   * pre-B3 root-level layout they were written against.
   */
  dataRoot?: string;
  legacyRoot?: string;
  principal: string;
  lockTimeoutMs?: number;
  /** @internal test seam: injected object-append failure (M4 typed-error tests). */
  failNextObjectAppend?: { cause: string };
}): ShellPersistence {
  const handle = composeHandle({
    root: opts.root,
    ...(opts.dataRoot === undefined ? {} : { dataRoot: opts.dataRoot }),
    legacyRoot: opts.legacyRoot,
    capability: 'shell',
    // F1/DEC-S2-11: shell's permitted kinds = layout, settings, conversationView.
    allowedKinds: ['layout', 'settings', 'conversationView'],
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
    async write(patch, expectedVersion, clientOpId) {
      // M4: store failures are typed PersistFailed Results, never raw throws.
      // M5: the CALLER's clientOpId threads to foundation meta (R3-10 dedup).
      if (expectedVersion === 0) {
        const res = await createObject<LayoutRecord>(handle, patch as LayoutRecord, clientOpId as unknown as ClientOpId);
        if (!res.ok) return fail(persistFailed('layout', res.error.code, res.error.message));
        return ok({ record: res.value.object as LayoutRecord, version: res.value.version });
      }
      const res = await updateObject<LayoutRecord>(handle, LAYOUT_MAIN_ID as unknown as ObjectId, patch, expectedVersion, clientOpId as unknown as ClientOpId);
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
    async write({ key, value, derivedFrom }, clientOpId) {
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
      const op = clientOpId as unknown as ClientOpId; // M5: caller-supplied, never re-minted
      const existing = await getObject<SettingsRecord>(handle, 'settings', record.id as unknown as ObjectId);
      if (existing.ok && !('absent' in existing.value)) {
        const res = await updateObject<SettingsRecord>(handle, record.id as unknown as ObjectId, record, existing.value.version, op);
        if (!res.ok) return fail(persistFailed('settings', res.error.code, res.error.message));
        return ok(res.value.object as SettingsRecord);
      }
      const res = await createObject<SettingsRecord>(handle, record, op);
      if (!res.ok) return fail(persistFailed('settings', res.error.code, res.error.message));
      return ok(res.value.object as SettingsRecord);
    },
  };

  const conversationViewDriver: ConversationViewDriver = {
    async list() {
      const res = await listObjects<ConversationViewRecord>(handle, 'conversationView');
      if (!res.ok) return [];
      const out: ConversationViewRecord[] = [];
      for (const item of res.value.items) {
        const parsed = ConversationViewRecord.safeParse(item.object);
        if (parsed.success) out.push(parsed.data); // "last good" — corrupt lines skipped
      }
      return out;
    },
    async get(id) {
      const res = await getObject<ConversationViewRecord>(handle, 'conversationView', id as unknown as ObjectId);
      if (!res.ok || 'absent' in res.value) return null;
      const parsed = ConversationViewRecord.safeParse(res.value.object);
      if (!parsed.success) return null; // corrupt → treated as absent
      return { record: parsed.data, version: res.value.version };
    },
    async create(record, clientOpId) {
      const res = await createObject<ConversationViewRecord>(handle, record, clientOpId as unknown as ClientOpId);
      if (!res.ok) return fail(persistFailed('conversationView', res.error.code, res.error.message));
      return ok({ record: res.value.object as ConversationViewRecord, version: res.value.version });
    },
    async update(id, patch, expectedVersion, clientOpId) {
      const res = await updateObject<ConversationViewRecord>(
        handle, id as unknown as ObjectId, patch, expectedVersion, clientOpId as unknown as ClientOpId);
      if (!res.ok) return fail(persistFailed('conversationView', res.error.code, res.error.message));
      return ok({ record: res.value.object as ConversationViewRecord, version: res.value.version });
    },
  };

  return { handle, layoutDriver, settingsDriver, conversationViewDriver };
}

/**
 * S2a: stored CAS version of any object on ANY composed handle (the agents
 * contract hides versions; the shell's agent-def editor needs them for
 * updateAgent CAS). Read-only.
 */
export async function objectVersion(
  handle: ScopedStoreHandle, kind: 'agent' | 'skill' | 'layout' | 'settings', id: string,
): Promise<number> {
  const res = await getObject(handle, kind, id as unknown as ObjectId);
  return res.ok && !('absent' in res.value) ? res.value.version : 0;
}
