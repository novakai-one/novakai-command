// core/sessions/registry.ts — the providerSession registry (DEC-B1-6).
//
// CRUD only after the SUPFIX step-0 split: the record shape lives in
// record-shape.ts, the OS probe in process-probe.ts, the boot sweep in
// orphan-sweep.ts. This file owns reading and mutating kind `providerSession`
// through the foundation store, and nothing else.
import {
  createObject, getObject, listObjects, updateObject,
} from '@novakai/foundation/dist/contract/index.js';
import type { ClientOpId, ObjectId } from '@novakai/foundation/dist/contract/brands.js';
import { isAbsent, type Result } from '@novakai/foundation/dist/contract/types.js';
import type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
import type { ProviderName } from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';
import {
  inFlightFrom,
  normalizeInFlight,
  type InFlightState,
  type ProviderSessionRecord,
  type ProviderSessionStatus,
  type ProviderSessionUsageMeasurement,
} from './record-shape.js';
import { osProcessProbe, type ProcessProbe } from './process-probe.js';
import { sweepOrphans, type SweepResult } from './orphan-sweep.js';

// Split-compat re-exports: every name registry.ts exported before the split
// keeps resolving from here, so no importer changes.
export {
  inFlightFrom, normalizeInFlight, parseProviderSessionRecord,
  type InFlightState, type InFlightTurn,
  type ParsedProviderSessionRecord,
  type ProviderSessionRecord, type ProviderSessionStatus,
  type ProviderSessionTokenUsage, type ProviderSessionUsageMeasurement,
  type ProviderSessionUsageUnavailable,
} from './record-shape.js';
export { osProcessProbe, type ProcessProbe } from './process-probe.js';
export type { SweepResult } from './orphan-sweep.js';

export interface RegisterSessionInput {
  sessionId: string;
  agentId: string;
  provider: ProviderName;
  cwd: string;
  model: string;
  providerConversationId?: string | null;
}

export interface ProviderSessionRegistry {
  register(input: RegisterSessionInput): Promise<Result<ProviderSessionRecord, StoreError>>;
  get(sessionId: string): Promise<ProviderSessionRecord | null>;
  list(): Promise<ProviderSessionRecord[]>;
  /** Sessions a restarted server may rebind (attach) — running ones only. */
  resumable(): Promise<ProviderSessionRecord[]>;
  recordResumeHandle(sessionId: string, providerConversationId: string): Promise<Result<ProviderSessionRecord, StoreError>>;
  recordModel(sessionId: string, model: string): Promise<Result<ProviderSessionRecord, StoreError>>;
  recordUsage(sessionId: string, usage: ProviderSessionUsageMeasurement): Promise<Result<ProviderSessionRecord, StoreError>>;
  markSending(sessionId: string, input: { clientOpId: string; pid?: number | null; pidStartedAt?: string | null }): Promise<Result<ProviderSessionRecord, StoreError>>;
  markReplied(sessionId: string): Promise<Result<ProviderSessionRecord, StoreError>>;
  /** Close one refused/failed provider turn without disturbing later queued turns. */
  markFailed(sessionId: string, clientOpId: string): Promise<Result<ProviderSessionRecord, StoreError>>;
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
    inFlight: normalizeInFlight(raw.inFlight as Partial<InFlightState> | undefined),
    lastInterruption: raw.lastInterruption ?? null,
    tokenUsage: raw.tokenUsage ?? null,
    usageUnavailable: raw.usageUnavailable ?? null,
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
        inFlight: inFlightFrom([]),
        lastInterruption: null,
        tokenUsage: null,
        usageUnavailable: null,
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

    async recordUsage(sessionId, usage) {
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
      if (usage.kind === 'measured') {
        const measured = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          source: usage.source,
          measuredAt: usage.measuredAt,
          ...(usage.usagePartial ? { usagePartial: true as const } : {}),
        };
        if (
          JSON.stringify(found.record.tokenUsage) === JSON.stringify(measured)
          && found.record.usageUnavailable === null
        ) {
          return { ok: true, value: found.record };
        }
        return patch(sessionId, () => ({
          tokenUsage: measured,
          usageUnavailable: null,
        }));
      }

      if (
        found.record.tokenUsage === null
        && found.record.usageUnavailable?.reason === usage.reason
      ) {
        return { ok: true, value: found.record };
      }
      return patch(sessionId, () => ({
        tokenUsage: null,
        usageUnavailable: {
          code: 'UsageUnavailable',
          reason: usage.reason,
          checkedAt: usage.checkedAt,
        },
      }));
    },

    markSending(sessionId, input) {
      return patch(sessionId, (record) => ({
        inFlight: inFlightFrom([...record.inFlight.queue, {
          clientOpId: input.clientOpId,
          pid: input.pid ?? null, pidStartedAt: input.pidStartedAt ?? null,
        }]),
        lastActivityAt: now(),
      }));
    },

    markReplied(sessionId) {
      return patch(sessionId, (record) => ({
        inFlight: inFlightFrom(record.inFlight.queue.slice(1)),
        turns: record.turns + 1,
        lastActivityAt: now(),
      }));
    },

    markFailed(sessionId, clientOpId) {
      return patch(sessionId, (record) => ({
        inFlight: inFlightFrom(record.inFlight.queue.filter((turn) => turn.clientOpId !== clientOpId)),
        lastActivityAt: now(),
      }));
    },

    clearInterruption(sessionId) {
      return patch(sessionId, () => ({ lastInterruption: null }));
    },

    close(sessionId, status) {
      return patch(sessionId, () => ({
        status,
        inFlight: inFlightFrom([]),
        lastActivityAt: now(),
      }));
    },

    sweepOrphans() {
      return sweepOrphans({ readAll, patch, probe, now });
    },
  };
}
