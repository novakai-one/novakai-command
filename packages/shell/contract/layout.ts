// shell/contract/layout.ts — layout object API (SHL-002/003, DEC-S3, R3-7).
// Layout is DATA, not code; every frame mutation is a settings edit.
import { DEFAULT_LAYOUT, LAYOUT_MAIN_ID, LayoutRecord } from './types.js';

/** Persistence seam. Node composition: foundation CAS-backed. Browser: bridge. */
export interface LayoutDriver {
  read(): Promise<{ record: LayoutRecord; version: number } | null>;
  write(patch: Partial<LayoutRecord>, expectedVersion: number): Promise<{ record: LayoutRecord; version: number }>;
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

export async function getLayout(driver: LayoutDriver): Promise<LayoutRecord> {
  const cur = await driver.read();
  if (cur) return cur.record;
  // First boot: persist the default so "last good" always exists.
  const created = await driver.write(defaultLayoutRecord(new Date().toISOString(), 'sys_shell'), 0);
  return created.record;
}

export async function getLayoutVersioned(driver: LayoutDriver): Promise<{ record: LayoutRecord; version: number }> {
  const cur = await driver.read();
  if (cur) return cur;
  return driver.write(defaultLayoutRecord(new Date().toISOString(), 'sys_shell'), 0);
}

/** Deep-merge a patch over the current record (layout edits are partial). */
export async function setLayout(
  driver: LayoutDriver,
  patch: Partial<LayoutRecord>,
): Promise<{ record: LayoutRecord; version: number }> {
  const cur = await getLayoutVersioned(driver);
  const merged: LayoutRecord = {
    ...cur.record,
    ...patch,
    rail: { ...cur.record.rail, ...(patch.rail ?? {}) },
    workspace: { ...cur.record.workspace, ...(patch.workspace ?? {}) },
    inspector: { ...cur.record.inspector, ...(patch.inspector ?? {}) },
    composer: { ...cur.record.composer, ...(patch.composer ?? {}) },
  };
  LayoutRecord.parse(merged); // never persist a record the schema rejects
  return driver.write(merged, cur.version);
}
