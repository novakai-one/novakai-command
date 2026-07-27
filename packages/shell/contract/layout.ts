// shell/contract/layout.ts — layout object API (SHL-002/003, DEC-S3, R3-7).
// Layout is DATA, not code; every frame mutation is a settings edit.
// M4: write failures cross the seam as typed PersistFailed Results, never throws.
import { DEFAULT_LAYOUT, LAYOUT_MAIN_ID, LayoutRecord } from './types.js';
import { fail, ok, type PersistFailedError, type Result } from './errors.js';

/** Persistence seam. Node composition: foundation CAS-backed. Browser: bridge. */
export interface LayoutDriver {
  read(): Promise<{ record: LayoutRecord; version: number } | null>;
  write(patch: Partial<LayoutRecord>, expectedVersion: number): Promise<Result<{ record: LayoutRecord; version: number }, PersistFailedError>>;
}

export function defaultLayoutRecord(now: string, createdBy: string): LayoutRecord {
  return {
    kind: 'layout',
    id: LAYOUT_MAIN_ID,
    schemaVersion: 1,
    createdAt: now,
    permissionLevel: 'private',
    createdBy,
    ...structuredClone(DEFAULT_LAYOUT),
  };
}

export async function getLayout(driver: LayoutDriver): Promise<Result<LayoutRecord, PersistFailedError>> {
  const cur = await driver.read();
  if (cur) return ok(cur.record);
  // First boot: persist the default so "last good" always exists.
  const created = await driver.write(defaultLayoutRecord(new Date().toISOString(), 'sys_shell'), 0);
  if (!created.ok) return fail(created.error);
  return ok(created.value.record);
}

export async function getLayoutVersioned(driver: LayoutDriver): Promise<Result<{ record: LayoutRecord; version: number }, PersistFailedError>> {
  const cur = await driver.read();
  if (cur) return ok(cur);
  return driver.write(defaultLayoutRecord(new Date().toISOString(), 'sys_shell'), 0);
}

/** Deep-merge a patch over the current record (layout edits are partial). */
export async function setLayout(
  driver: LayoutDriver,
  patch: Partial<LayoutRecord>,
): Promise<Result<{ record: LayoutRecord; version: number }, PersistFailedError>> {
  const cur = await getLayoutVersioned(driver);
  if (!cur.ok) return fail(cur.error);
  const merged: LayoutRecord = {
    ...cur.value.record,
    ...patch,
    rail: { ...cur.value.record.rail, ...(patch.rail ?? {}) },
    workspace: { ...cur.value.record.workspace, ...(patch.workspace ?? {}) },
    inspector: { ...cur.value.record.inspector, ...(patch.inspector ?? {}) },
    composer: { ...cur.value.record.composer, ...(patch.composer ?? {}) },
  };
  LayoutRecord.parse(merged); // never persist a record the schema rejects
  return driver.write(merged, cur.value.version);
}
