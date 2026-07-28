// core/sessions/registry.ts — the providerSession registry (DEC-B1-6).
//
// A logical agents session (`sess_<uuid>`) maps to a PROVIDER CONVERSATION id.
// Physical CLI processes come and go under it (DEC-B1-5), so what has to
// survive a server restart is the resumable HANDLE, not a process:
//
//     sessionId · agentId · provider · providerConversationId · cwd · model
//     spawnedAt · lastActivityAt · turns · status · inFlight · lastInterruption
//
// Red gate 6 / A-7: these records are handles, never durable identity. Nothing
// derives an identity from a pid or a provider session id.
//
// §13 disposition 2 (restart-resume semantics): `inFlight` carries
// {clientOpId, status}. send → generating; reply completion → none. A server
// that dies while generating leaves the flag set; the boot sweep turns that
// into ONE typed `ReplyInterrupted` per interrupted send — surfaced in the
// thread as "reply interrupted — resend?", NEVER auto-retried. A manual resend
// reuses the same clientOpId, so messaging idempotency prevents a double post.
import { execFileSync } from 'node:child_process';
import {
  createObject, getObject, listObjects, updateObject,
} from '@novakai/foundation/dist/contract/index.js';
import type { ClientOpId, ObjectId } from '@novakai/foundation/dist/contract/brands.js';
import { isAbsent, type Result } from '@novakai/foundation/dist/contract/types.js';
import type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
import type { ProviderName } from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';

export type ProviderSessionStatus = 'running' | 'closed' | 'exited';

export interface ProviderSessionRecord {
  sessionId: string;
  agentId: string;
  provider: ProviderName;
  /** The provider's own conversation id — the resume handle (kimi: `-S <id>`). */
  providerConversationId: string | null;
  cwd: string;
  model: string;
  spawnedAt: string;
  lastActivityAt: string;
  turns: number;
  status: ProviderSessionStatus;
  inFlight: { clientOpId: string | null; status: 'generating' | 'none'; pid: number | null; pidStartedAt: string | null };
  /** Set by the boot sweep; cleared when the operator resends. */
  lastInterruption: { clientOpId: string; at: string; reason: 'ReplyInterrupted' } | null;
}

export interface RegisterSessionInput {
  sessionId: string;
  agentId: string;
  provider: ProviderName;
  cwd: string;
  model: string;
  providerConversationId?: string | null;
}

export interface SweepResult {
  /** One entry per send that was generating when the server died. */
  interrupted: Array<{ sessionId: string; clientOpId: string; reason: 'ReplyInterrupted' }>;
  /** Orphaned child pids we positively identified as ours and reaped. */
  killed: number[];
}

/**
 * Internal seam (§13 disposition 10): "is this pid still alive, and is it still
 * the process we spawned?" Production probes the OS; tests inject a fake. Two
 * real adapters, so the seam earns its place.
 */
export interface ProcessProbe {
  alive(pid: number): boolean;
  /** The OS-reported start time, or null when it cannot be read. */
  startedAt(pid: number): string | null;
  kill?(pid: number): void;
}

export const osProcessProbe: ProcessProbe = {
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  startedAt(pid) {
    try {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null;
    } catch { return null; }
  },
  kill(pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone — nothing to reap */ }
  },
};

export interface ProviderSessionRegistry {
  register(input: RegisterSessionInput): Promise<Result<ProviderSessionRecord, StoreError>>;
  get(sessionId: string): Promise<ProviderSessionRecord | null>;
  list(): Promise<ProviderSessionRecord[]>;
  /** Sessions a restarted server may rebind (attach) — running ones only. */
  resumable(): Promise<ProviderSessionRecord[]>;
  recordResumeHandle(sessionId: string, providerConversationId: string): Promise<Result<ProviderSessionRecord, StoreError>>;
  recordModel(sessionId: string, model: string): Promise<Result<ProviderSessionRecord, StoreError>>;
  markSending(sessionId: string, input: { clientOpId: string; pid?: number | null; pidStartedAt?: string | null }): Promise<Result<ProviderSessionRecord, StoreError>>;
  markReplied(sessionId: string): Promise<Result<ProviderSessionRecord, StoreError>>;
  /** The operator resent the interrupted message: clear the surfaced flag. */
  clearInterruption(sessionId: string): Promise<Result<ProviderSessionRecord, StoreError>>;
  close(sessionId: string, status: Exclude<ProviderSessionStatus, 'running'>): Promise<Result<ProviderSessionRecord, StoreError>>;
  /** Boot step: reap our orphans and turn in-flight sends into typed interruptions. */
  sweepOrphans(): Promise<SweepResult>;
}

const now = () => new Date().toISOString();
const mintOpId = (): ClientOpId => `op_${globalThis.crypto.randomUUID()}` as ClientOpId;

type StoredShape = ProviderSessionRecord & { id: string; kind: 'providerSession' };

function toRecord(object: Record<string, unknown>): ProviderSessionRecord {
  const raw = object as unknown as StoredShape;
  return {
    sessionId: raw.sessionId, agentId: raw.agentId, provider: raw.provider,
    providerConversationId: raw.providerConversationId ?? null,
    cwd: raw.cwd, model: raw.model,
    spawnedAt: raw.spawnedAt, lastActivityAt: raw.lastActivityAt,
    turns: raw.turns ?? 0, status: raw.status,
    inFlight: raw.inFlight ?? { clientOpId: null, status: 'none', pid: null, pidStartedAt: null },
    lastInterruption: raw.lastInterruption ?? null,
  };
}

export function createProviderSessionRegistry(
  ctx: AgentsContext,
  probe: ProcessProbe = osProcessProbe,
): ProviderSessionRegistry {
  const idOf = (sessionId: string): ObjectId => sessionId as ObjectId;

  const readAll = async (): Promise<Array<{ record: ProviderSessionRecord; version: number }>> => {
    const res = await listObjects<Record<string, unknown>>(ctx.handle, 'providerSession', undefined, { limit: 10_000 });
    if (!res.ok) return [];
    return res.value.items.map((item) => ({ record: toRecord(item.object as Record<string, unknown>), version: item.version }));
  };

  const readOne = async (sessionId: string): Promise<{ record: ProviderSessionRecord; version: number } | null> => {
    const res = await getObject<Record<string, unknown>>(ctx.handle, 'providerSession', idOf(sessionId));
    if (!res.ok || isAbsent(res.value)) return null;
    return { record: toRecord(res.value.object as Record<string, unknown>), version: res.value.version };
  };

  /** Single-object mutation (R3-18): read → patch → CAS write, one object. */
  const patch = async (
    sessionId: string, mutate: (record: ProviderSessionRecord) => Partial<ProviderSessionRecord>,
  ): Promise<Result<ProviderSessionRecord, StoreError>> => {
    const found = await readOne(sessionId);
    if (!found) {
      return {
        ok: false,
        error: {
          code: 'NotFound', message: `no providerSession "${sessionId}"`,
          details: { ref: { kind: 'providerSession', id: sessionId } }, retryable: false,
        },
      };
    }
    const res = await updateObject<Record<string, unknown>>(
      ctx.handle, idOf(sessionId),
      mutate(found.record) as Record<string, unknown>,
      found.version, mintOpId(),
    );
    return res.ok ? { ok: true, value: toRecord(res.value.object as Record<string, unknown>) } : { ok: false, error: res.error };
  };

  return {
    async register(input) {
      const at = now();
      const record = {
        kind: 'providerSession' as const,
        id: input.sessionId,
        schemaVersion: 1,
        createdAt: at,
        permissionLevel: 'private' as const,
        createdBy: 'overridden-by-foundation', // red gate 4
        sessionId: input.sessionId,
        agentId: input.agentId,
        provider: input.provider,
        providerConversationId: input.providerConversationId ?? null,
        cwd: input.cwd,
        model: input.model,
        spawnedAt: at,
        lastActivityAt: at,
        turns: 0,
        status: 'running' as ProviderSessionStatus,
        inFlight: { clientOpId: null, status: 'none' as const, pid: null, pidStartedAt: null },
        lastInterruption: null,
      };
      const res = await createObject<Record<string, unknown>>(ctx.handle, record, mintOpId());
      return res.ok ? { ok: true, value: toRecord(res.value.object as Record<string, unknown>) } : { ok: false, error: res.error };
    },

    async get(sessionId) {
      return (await readOne(sessionId))?.record ?? null;
    },

    async list() {
      return (await readAll()).map((r) => r.record);
    },

    async resumable() {
      return (await readAll()).map((r) => r.record).filter((r) => r.status === 'running');
    },

    recordResumeHandle(sessionId, providerConversationId) {
      return patch(sessionId, () => ({ providerConversationId, lastActivityAt: now() }));
    },

    recordModel(sessionId, model) {
      return patch(sessionId, () => ({ model, lastActivityAt: now() }));
    },

    markSending(sessionId, input) {
      return patch(sessionId, () => ({
        inFlight: {
          clientOpId: input.clientOpId, status: 'generating',
          pid: input.pid ?? null, pidStartedAt: input.pidStartedAt ?? null,
        },
        lastActivityAt: now(),
      }));
    },

    markReplied(sessionId) {
      return patch(sessionId, (record) => ({
        inFlight: { clientOpId: null, status: 'none', pid: null, pidStartedAt: null },
        turns: record.turns + 1,
        lastActivityAt: now(),
      }));
    },

    clearInterruption(sessionId) {
      return patch(sessionId, () => ({ lastInterruption: null }));
    },

    close(sessionId, status) {
      return patch(sessionId, () => ({
        status,
        inFlight: { clientOpId: null, status: 'none', pid: null, pidStartedAt: null },
        lastActivityAt: now(),
      }));
    },

    async sweepOrphans() {
      const result: SweepResult = { interrupted: [], killed: [] };
      for (const { record } of await readAll()) {
        if (record.inFlight.status !== 'generating') continue;
        const { pid, pidStartedAt, clientOpId } = record.inFlight;
        // §13 disposition 10: only kill a pid we can PROVE is still the child we
        // spawned — a recycled pid belongs to somebody else's process.
        if (pid !== null && probe.alive(pid) && pidStartedAt !== null && probe.startedAt(pid) === pidStartedAt) {
          probe.kill?.(pid);
          result.killed.push(pid);
        }
        const at = now();
        await patch(record.sessionId, () => ({
          inFlight: { clientOpId: null, status: 'none', pid: null, pidStartedAt: null },
          lastInterruption: clientOpId ? { clientOpId, at, reason: 'ReplyInterrupted' as const } : null,
          lastActivityAt: at,
        }));
        if (clientOpId) {
          result.interrupted.push({ sessionId: record.sessionId, clientOpId, reason: 'ReplyInterrupted' });
        }
      }
      return result;
    },
  };
}
