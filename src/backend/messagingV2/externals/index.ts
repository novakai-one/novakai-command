/**
 * Externals store (D-N8-1): durable external principals — humans OUTSIDE
 * the workspace (PartnerChris) with their own personId, so a Slack reply
 * can land in the app AS THEM (the N7 bridge's owner-only inbound was the
 * honest placeholder until these existed).
 *
 * Conventions follow the token store (../tokens): append-only jsonl,
 * supersede-by-id fold (last line wins), chmod 600, gitignored. Records:
 *   { id: 'external_<uuid>', kind: 'external-principal', schemaVersion: 1,
 *     createdAt, personId: 'person_ext_<slug>', slackUserId, displayName,
 *     revoked?: true }
 * personIds are minted from the display name (contract pattern
 * ^person_[A-Za-z0-9-]+$); a re-add after revoke mints a FRESH record —
 * revocation history is never rewritten.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ExternalRecord {
  id: string;
  kind: 'external-principal';
  schemaVersion: 1;
  createdAt: string;
  personId: string;
  slackUserId: string;
  displayName: string;
  revoked?: boolean;
}

export interface ExternalsStore {
  provision(input: { slackUserId: string; displayName: string }): ExternalRecord;
  list(): ExternalRecord[];
  revokeBySlackUser(slackUserId: string): ExternalRecord[];
  /** The authority/membership/policy seam question: active right now? */
  isActive(personId: string): boolean;
  activePersonIds(): string[];
  recordForSlackUser(slackUserId: string): ExternalRecord | null;
}

export function defaultExternalsPath(): string {
  return process.env.NVK_MESSAGING_V2_EXTERNALS
    ?? path.resolve('.novakai-command', 'messaging-v2', 'externals.jsonl');
}

function fold(storePath: string): Map<string, ExternalRecord> {
  const byId = new Map<string, ExternalRecord>();
  if (!existsSync(storePath)) return byId;
  for (const line of readFileSync(storePath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as ExternalRecord;
      if (record.kind === 'external-principal' && typeof record.id === 'string') byId.set(record.id, record);
    } catch {
      // torn lines never block the rest (the store fold's tolerance rule)
    }
  }
  return byId;
}

interface StoreState {
  storePath: string;
  byId: Map<string, ExternalRecord> | null;
  foldedMtimeMs: number;
  foldedSize: number;
}

/** The fold with a freshness check — CLI-side appends become visible here. */
function freshRecords(state: StoreState): Map<string, ExternalRecord> {
  const stat = existsSync(state.storePath) ? statSync(state.storePath) : null;
  const mtimeMs = stat?.mtimeMs ?? -1;
  const size = stat?.size ?? -1;
  if (state.byId === null || mtimeMs !== state.foldedMtimeMs || size !== state.foldedSize) {
    state.byId = fold(state.storePath);
    state.foldedMtimeMs = mtimeMs;
    state.foldedSize = size;
  }
  return state.byId;
}

function appendRecord(state: StoreState, record: ExternalRecord): void {
  mkdirSync(path.dirname(state.storePath), { recursive: true });
  if (!existsSync(state.storePath)) writeFileSync(state.storePath, '', { mode: 0o600 });
  chmodSync(state.storePath, 0o600); // a hand-created loose file is tightened
  appendFileSync(state.storePath, `${JSON.stringify(record)}\n`);
  state.byId?.set(record.id, record);
}

function slugFor(displayName: string, fallbackId: string): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? `x-${fallbackId.slice(0, 8)}` : slug;
}

function provision(state: StoreState, input: { slackUserId: string; displayName: string }): ExternalRecord {
  // Idempotent (the store's own discipline): an ACTIVE record for this
  // slackUserId already exists → return IT, never a duplicate principal.
  const existing = [...freshRecords(state).values()].find(
    (record) => record.slackUserId === input.slackUserId && record.revoked !== true,
  );
  if (existing !== undefined) return existing;
  const id = `external_${randomUUID()}`;
  const record: ExternalRecord = {
    id,
    kind: 'external-principal',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    personId: `person_ext-${slugFor(input.displayName, id)}`,
    slackUserId: input.slackUserId,
    displayName: input.displayName,
  };
  appendRecord(state, record);
  return record;
}

function revokeFor(state: StoreState, slackUserId: string): ExternalRecord[] {
  const live = [...freshRecords(state).values()].filter(
    (record) => record.slackUserId === slackUserId && record.revoked !== true,
  );
  for (const record of live) appendRecord(state, { ...record, revoked: true });
  return live.map((record) => ({ ...record, revoked: true as const }));
}

function isActiveRecord(state: StoreState, personId: string): boolean {
  return [...freshRecords(state).values()].some(
    (record) => record.personId === personId && record.revoked !== true,
  );
}

export function createExternalsStore(storePath: string = defaultExternalsPath()): ExternalsStore {
  const state: StoreState = { storePath, byId: null, foldedMtimeMs: -1, foldedSize: -1 };
  return {
    provision: (input) => provision(state, input),
    list: () => [...freshRecords(state).values()],
    revokeBySlackUser: (slackUserId) => revokeFor(state, slackUserId),
    isActive: (personId) => isActiveRecord(state, personId),
    activePersonIds: () =>
      [...freshRecords(state).values()]
        .filter((record) => record.revoked !== true)
        .map((record) => record.personId),
    recordForSlackUser: (slackUserId) =>
      [...freshRecords(state).values()].find(
        (record) => record.slackUserId === slackUserId && record.revoked !== true,
      ) ?? null,
  };
}
