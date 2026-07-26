/**
 * Agent-token store (D-N6-2): durable issuance/revocation for messaging
 * credentials — the real tokens that retire D-N2-2 (agentId-as-token).
 *
 * File: append-only jsonl (the repo's store convention — one record per
 * line, supersede-by-id fold, last line wins). Records:
 *   { id: 'agenttoken_<uuid>', kind: 'agent-token', schemaVersion: 1,
 *     createdAt, agentId, tokenHash, revoked?: true }
 * Token format nvkt_<64 hex> (256-bit random); only the SHA-256 hash ever
 * persists — the raw token is printed ONCE at issuance (by the caller) and
 * held in-process for this run's consumers, NEVER written to disk. The file
 * is created chmod 600 and gitignored (.novakai-command/messaging-v2/).
 *
 * Cross-process truth: the nvk-agent CLI appends from a second process, so
 * resolve/isRevoked re-fold the file whenever it changed on disk (mtime/size
 * check — the fold itself only runs on change). The same rule governs the
 * in-process raw cache (F1): a held raw whose records are ALL revoked (the
 * CLI revoked from another process) is NOT a credential — ensure() re-mints
 * and refreshes the cache, tokenForAgent() never serves the dead raw. A
 * restart drops the raw cache entirely, but the hash still authenticates.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentTokenRecord {
  id: string;
  kind: 'agent-token';
  schemaVersion: 1;
  createdAt: string;
  agentId: string;
  /** SHA-256 of the raw token — the ONLY persisted form. */
  tokenHash: string;
  revoked?: boolean;
}

export interface TokenStore {
  /** Mint + persist; the raw token is returned ONCE (caller prints it). */
  issue(agentId: string): { record: AgentTokenRecord; token: string };
  /** Boot/launch zero-touch: mint only when no in-process raw is held. */
  ensure(agentId: string): void;
  /** This process's raw token for the agent (null after a restart). */
  tokenForAgent(agentId: string): string | null;
  /** Hash lookup over the fresh fold; null = unknown or revoked. */
  resolve(token: string): { agentId: string; recordId: string } | null;
  /** Record-level revocation truth (revalidate's §2.1 re-check). */
  isRevoked(recordId: string): boolean;
  /** Append the revoked marker to every live token of the agent. */
  revokeAll(agentId: string): AgentTokenRecord[];
  /** Every record for the agent (ids/created/revoked — NEVER the token). */
  listFor(agentId: string): AgentTokenRecord[];
}

export function defaultTokenStorePath(): string {
  return process.env.NVK_MESSAGING_V2_TOKENS
    ?? path.resolve('.novakai-command', 'messaging-v2', 'tokens.jsonl');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function fold(storePath: string): Map<string, AgentTokenRecord> {
  const byId = new Map<string, AgentTokenRecord>();
  if (!existsSync(storePath)) return byId;
  for (const line of readFileSync(storePath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as AgentTokenRecord;
      if (record.kind === 'agent-token' && typeof record.id === 'string') byId.set(record.id, record);
    } catch {
      // torn lines never block the rest (the store fold's tolerance rule)
    }
  }
  return byId;
}

interface StoreState {
  storePath: string;
  /** Fold cache + its on-disk fingerprint (re-fold only on change). */
  byId: Map<string, AgentTokenRecord> | null;
  foldedMtimeMs: number;
  foldedSize: number;
  /** Process-local raw tokens (this run's mints) — never persisted. */
  rawByAgent: Map<string, string>;
}

/** The fold with a freshness check — CLI-side appends become visible here. */
function freshRecords(state: StoreState): Map<string, AgentTokenRecord> {
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

function appendRecord(state: StoreState, record: AgentTokenRecord): void {
  mkdirSync(path.dirname(state.storePath), { recursive: true });
  if (!existsSync(state.storePath)) writeFileSync(state.storePath, '', { mode: 0o600 });
  // F3: a hand-created or umask-loose file is tightened, never left readable
  // (appends are rare — the chmod is noise against the write itself).
  chmodSync(state.storePath, 0o600);
  appendFileSync(state.storePath, `${JSON.stringify(record)}\n`);
  state.byId?.set(record.id, record);
}

function mint(state: StoreState, agentId: string): { record: AgentTokenRecord; token: string } {
  const token = `nvkt_${randomBytes(32).toString('hex')}`;
  const record: AgentTokenRecord = {
    id: `agenttoken_${randomUUID()}`,
    kind: 'agent-token',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    agentId,
    tokenHash: hashToken(token),
  };
  appendRecord(state, record);
  state.rawByAgent.set(agentId, token);
  return { record, token };
}

function resolveToken(state: StoreState, token: string): { agentId: string; recordId: string } | null {
  const hashed = hashToken(token);
  for (const record of freshRecords(state).values()) {
    if (record.tokenHash === hashed && record.revoked !== true) {
      return { agentId: record.agentId, recordId: record.id };
    }
  }
  return null;
}

function revokeAllFor(state: StoreState, agentId: string): AgentTokenRecord[] {
  const live = [...freshRecords(state).values()].filter(
    (record) => record.agentId === agentId && record.revoked !== true,
  );
  for (const record of live) appendRecord(state, { ...record, revoked: true });
  state.rawByAgent.delete(agentId); // a revoked identity re-mints on next ensure
  return live.map((record) => ({ ...record, revoked: true as const }));
}

/** F1: does the fresh fold hold ANY live (non-revoked) record for the agent? */
function hasLiveRecord(state: StoreState, agentId: string): boolean {
  return [...freshRecords(state).values()].some(
    (record) => record.agentId === agentId && record.revoked !== true,
  );
}

/** This process's raw for the agent — F1: never a dead raw (a second
 * process's revocation retires it; the cache is not the truth, the fold is). */
function rawForAgent(state: StoreState, agentId: string): string | null {
  const heldRaw = state.rawByAgent.get(agentId) ?? null;
  if (heldRaw !== null && !hasLiveRecord(state, agentId)) return null;
  return heldRaw;
}

export function createTokenStore(storePath: string = defaultTokenStorePath()): TokenStore {
  const state: StoreState = {
    storePath, byId: null, foldedMtimeMs: -1, foldedSize: -1, rawByAgent: new Map(),
  };
  return {
    issue: (agentId) => mint(state, agentId),
    ensure: (agentId) => {
      // F1: a held raw whose records are ALL revoked (a second process
      // revoked them) is NOT a credential — re-mint and refresh the cache.
      if (!state.rawByAgent.has(agentId) || !hasLiveRecord(state, agentId)) mint(state, agentId);
    },
    tokenForAgent: (agentId) => rawForAgent(state, agentId),
    resolve: (token) => resolveToken(state, token),
    isRevoked: (recordId) => freshRecords(state).get(recordId)?.revoked === true,
    revokeAll: (agentId) => revokeAllFor(state, agentId),
    listFor: (agentId) =>
      [...freshRecords(state).values()].filter((record) => record.agentId === agentId),
  };
}
