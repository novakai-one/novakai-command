// shell/contract/terminalTab.ts — the `terminalTab` durable record
// (FZ-VIEW-017, P2 §10:1714–1727).
//
// This is the Shell's fourth and LAST allowed kind. FZ-VIEW-018 closes the set
// at `layout`, `settings`, `conversationView`, `terminalTab` — no
// `terminalPreference`, no Shell-specific store engine. Persisted exactly the
// way the other three are: through the one scoped Foundation handle, so the
// record is enveloped, traced and CAS-guarded, and a retry carrying the same
// `clientOpId` never double-applies (LAW 1).
//
// What this record is NOT: a claim on the terminal session. The session belongs
// to the Runtime and outlives every tab that ever showed it. A tab closing is a
// Shell fact — the window detaching — and red gate 1 is the reason that
// distinction is spelled out in the tests rather than assumed.
import { z } from 'zod';
import { fail, persistFailed, type PersistFailedError, type Result } from './errors.js';

/**
 * Calm's pacing INPUTS are frozen (FZ-VIEW-017); how Calm actually paces is
 * builder freedom (P-20). Bounds live here so the picker that offers a value
 * and the validator that accepts it cannot disagree — the failure shape where
 * a UI hands you a setting the store then refuses.
 *
 * The floors are the interesting end. A `revealLinesPerSecond` of 0 is a tab
 * that never reveals anything, and a `maxBufferedLines` of 0 is a tab that
 * silently drops every line: both look exactly like a hung terminal, which is
 * the one thing a terminal must never look like when it is fine.
 */
export const CALM_PACING_LIMITS = {
  maxBufferedLines: { floor: 100, ceiling: 100_000 },
  revealLinesPerSecond: { floor: 1, ceiling: 2_000 },
} as const;

const bounded = (limit: { floor: number; ceiling: number }) =>
  z.number().int().min(limit.floor).max(limit.ceiling);

export const TerminalTabRecord = z.object({
  kind: z.literal('terminalTab'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('private'),
  createdBy: z.string().min(1),
  /**
   * Which session this tab shows. Prefix-checked: FZ-CLI-SCHEMA-009 requires a
   * validator to reject a wrong prefix even when the remainder is well-formed,
   * because an `agentRun_…` in this slot would attach a tab to the wrong thing
   * and read as a UI bug rather than as the identity error it is.
   */
  terminalSessionId: z.string().regex(/^terminal_[0-9a-fA-F-]{36}$/u),
  mode: z.enum(['raw', 'calm']),
  title: z.string(),
  zoom: z.number().positive().max(8),
  calmPacing: z.object({
    maxBufferedLines: bounded(CALM_PACING_LIMITS.maxBufferedLines),
    revealLinesPerSecond: bounded(CALM_PACING_LIMITS.revealLinesPerSecond),
  }),
  state: z.enum(['open', 'closed']),
}).strict();
export type TerminalTabRecord = z.infer<typeof TerminalTabRecord>;

/** Persistence seam. Node composition: Foundation CAS-backed, like the rest. */
export interface TerminalTabDriver {
  list(): Promise<TerminalTabRecord[]>;
  read(id: string): Promise<{ record: TerminalTabRecord; version: number } | null>;
  create(record: TerminalTabRecord, clientOpId: string):
    Promise<Result<{ record: TerminalTabRecord; version: number }, PersistFailedError>>;
  update(id: string, record: TerminalTabRecord, expectedVersion: number, clientOpId: string):
    Promise<Result<{ record: TerminalTabRecord; version: number }, PersistFailedError>>;
}

export interface TerminalTabPatch {
  terminalSessionId?: string;
  mode?: 'raw' | 'calm';
  title?: string;
  zoom?: number;
  calmPacing?: { maxBufferedLines: number; revealLinesPerSecond: number };
  state?: 'open' | 'closed';
}

const DEFAULT_PACING = { maxBufferedLines: 2_000, revealLinesPerSecond: 24 } as const;

/**
 * The one write path. Create-on-absent, CAS update otherwise, `clientOpId`
 * required — minted at the interaction layer, deduped by Foundation.
 */
export async function setTerminalTab(
  driver: TerminalTabDriver,
  id: string,
  patch: TerminalTabPatch,
  clientOpId: string,
): Promise<Result<{ record: TerminalTabRecord; version: number }, PersistFailedError>> {
  const current = await driver.read(id);
  if (current === null) {
    if (patch.terminalSessionId === undefined) {
      return fail(persistFailed('terminalTab', 'MissingSession', 'a new tab must name the session it shows'));
    }
    const record = TerminalTabRecord.parse({
      kind: 'terminalTab',
      id,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'private',
      createdBy: 'overridden-by-foundation',
      terminalSessionId: patch.terminalSessionId,
      mode: patch.mode ?? 'raw',
      title: patch.title ?? '',
      zoom: patch.zoom ?? 1,
      calmPacing: patch.calmPacing ?? DEFAULT_PACING,
      state: patch.state ?? 'open',
    });
    return driver.create(record, clientOpId);
  }
  const merged = TerminalTabRecord.parse({ ...current.record, ...patch });
  return driver.update(id, merged, current.version, clientOpId);
}

/**
 * FZ-VIEW-033: closing a tab detaches this window. It does not stop anything.
 * The record is kept, `terminalSessionId` and all — a Shell that forgets which
 * session a closed tab was showing is how "I closed the tab" turns into "I lost
 * the agent" in Chris's head while the process is perfectly fine.
 */
export async function closeTerminalTab(
  driver: TerminalTabDriver,
  id: string,
  clientOpId: string,
): Promise<Result<{ record: TerminalTabRecord; version: number }, PersistFailedError>> {
  const current = await driver.read(id);
  if (current === null) return fail(persistFailed('terminalTab', 'NotFound', `no terminal tab ${id}`));
  return setTerminalTab(driver, id, { state: 'closed' }, clientOpId);
}

/**
 * What comes back after a reload: the tabs that were open, in stored order.
 *
 * A row the schema cannot parse is SKIPPED rather than thrown — the
 * deferred-structure law. One unreadable record must not cost Chris every tab
 * he had open, and a restore that throws is a restore that shows him nothing.
 */
export async function listOpenTerminalTabs(
  driver: TerminalTabDriver,
): Promise<TerminalTabRecord[]> {
  const rows = await driver.list();
  const open: TerminalTabRecord[] = [];
  for (const stored of rows) {
    const parsed = TerminalTabRecord.safeParse(stored);
    if (parsed.success && parsed.data.state === 'open') open.push(parsed.data);
  }
  return open;
}
