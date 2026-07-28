// shell/contract/conversationView.ts — DEC-S2-11 (RULED): pin/archive/
// title-override are list-arrangement VIEW STATE owned by the shell — never
// thread facts (messaging stays clean of UI concepts; this state survives
// swapping messaging backends). Refs the thread by {kind:'thread',id}
// (deferred-structure law: a dangling ref is drawn absence, never a crash).
// Persisted via the foundation scoped handle like layout/settings (R3-7):
// enveloped, traced, CAS-guarded; UI-originated mutations carry clientOpId
// (R3-10: a retry with the same clientOpId never double-applies).
import { z } from 'zod';
import { fail, ok, type PersistFailedError, type Result } from './errors.js';

export const ConversationViewRecord = z.object({
  kind: z.literal('conversationView'),
  id: z.string().min(1), // the shell conversation id (conv_…)
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('private'),
  createdBy: z.string().min(1),
  /** {kind:'thread',id} once the messaging thread exists; null until then. */
  threadRef: z.object({ kind: z.string().min(1), id: z.string().min(1) }).nullable(),
  /**
   * Pre-thread messaging address. Older demo records may omit this or carry an
   * empty/invalid value; boot classifies those conservatively.
   */
  address: z.string().optional(),
  pinned: z.boolean(),
  archived: z.boolean(),
  titleOverride: z.string().optional(),
  lastActivityAt: z.string().datetime(),
});
export type ConversationViewRecord = z.infer<typeof ConversationViewRecord>;

/** Persistence seam. Node composition: foundation CAS-backed. */
export interface ConversationViewDriver {
  list(): Promise<ConversationViewRecord[]>;
  get(id: string): Promise<{ record: ConversationViewRecord; version: number } | null>;
  create(record: ConversationViewRecord, clientOpId: string):
    Promise<Result<{ record: ConversationViewRecord; version: number }, PersistFailedError>>;
  update(id: string, patch: Partial<ConversationViewRecord>, expectedVersion: number, clientOpId: string):
    Promise<Result<{ record: ConversationViewRecord; version: number }, PersistFailedError>>;
}

export interface ConversationViewPatch {
  threadRef?: { kind: string; id: string } | null;
  address?: string;
  pinned?: boolean;
  archived?: boolean;
  titleOverride?: string;
  lastActivityAt?: string;
}

/**
 * The one write path (§8: setConversationView). Create-on-absent, CAS update
 * otherwise. clientOpId REQUIRED — minted at the interaction layer (M5/
 * DEC-S2-12); foundation dedups retries (R3-10 → no duplicate objects).
 */
export async function setConversationView(
  driver: ConversationViewDriver,
  id: string,
  patch: ConversationViewPatch,
  clientOpId: string,
): Promise<Result<{ record: ConversationViewRecord; version: number }, PersistFailedError>> {
  const cur = await driver.get(id);
  if (!cur) {
    const record: ConversationViewRecord = {
      kind: 'conversationView',
      id,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'private',
      createdBy: 'overridden-by-foundation',
      threadRef: patch.threadRef ?? null,
      ...(patch.address !== undefined ? { address: patch.address } : {}),
      pinned: patch.pinned ?? false,
      archived: patch.archived ?? false,
      ...(patch.titleOverride !== undefined ? { titleOverride: patch.titleOverride } : {}),
      lastActivityAt: patch.lastActivityAt ?? new Date().toISOString(),
    };
    ConversationViewRecord.parse(record); // never persist a record the schema rejects
    return driver.create(record, clientOpId);
  }
  const merged: ConversationViewRecord = { ...cur.record, ...patch };
  ConversationViewRecord.parse(merged);
  return driver.update(id, merged, cur.version, clientOpId);
}

export async function getConversationView(
  driver: ConversationViewDriver, id: string,
): Promise<ConversationViewRecord | null> {
  const cur = await driver.get(id);
  return cur ? cur.record : null;
}

export async function listConversationViews(
  driver: ConversationViewDriver,
): Promise<ConversationViewRecord[]> {
  return driver.list();
}
