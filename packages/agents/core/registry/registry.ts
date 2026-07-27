// core/registry — agent definitions in agents.jsonl via the foundation scoped
// handle (kind 'agent'; the SCOPE CHECK lives in foundation's contract layer
// (api.ts scopeCheck) — the engine performs no scope check; M3 audit
// correction, DEC-S2-14). Envelope/trace laws are foundation's; this module
// shapes the agent payload (AGT-004).
import { randomUUID } from 'node:crypto';
import {
  createObject, getObject, listObjects, updateObject,
} from '@novakai/foundation/dist/contract/index.js';
import type { AgentId, ClientOpId, ObjectId } from '@novakai/foundation/dist/contract/brands.js';
import type { Absent, Page, ListFilter, Result } from '@novakai/foundation/dist/contract/types.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
import { err } from '@novakai/foundation/dist/contract/errors.js';
import type { AgentDefinitionLiteT as AgentDefinitionLite } from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';

export type DefineAgentInput = Omit<AgentDefinitionLite,
  'kind' | 'id' | 'schemaVersion' | 'createdAt' | 'createdBy'>;

export async function defineAgent(
  ctx: AgentsContext, def: DefineAgentInput, clientOpId: ClientOpId,
): Promise<Result<AgentDefinitionLite, StoreError>> {
  const id = `agent_${randomUUID()}` as AgentId;
  const record: AgentDefinitionLite = {
    kind: 'agent',
    id,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: def.permissionLevel ?? 'private',
    createdBy: 'overridden-by-foundation', // red gate 4: foundation stamps the token principal
    displayName: def.displayName,
    provider: def.provider,
    model: def.model,
    hooks: def.hooks ?? [],
    status: def.status ?? 'defined',
  };
  const res = await createObject<AgentDefinitionLite>(ctx.handle, record, clientOpId);
  if (!res.ok) return res;
  return { ok: true, value: res.value.object };
}

export async function updateAgent(
  ctx: AgentsContext, id: AgentId, patch: Partial<AgentDefinitionLite>,
  expectedVersion: number, clientOpId: ClientOpId,
): Promise<Result<AgentDefinitionLite, StoreError>> {
  const res = await updateObject<AgentDefinitionLite>(ctx.handle, id as unknown as ObjectId, patch, expectedVersion, clientOpId);
  if (!res.ok) return res;
  return { ok: true, value: res.value.object };
}

export async function getAgent(
  ctx: AgentsContext, id: AgentId,
): Promise<Result<AgentDefinitionLite | Absent, never>> {
  const res = await getObject<AgentDefinitionLite>(ctx.handle, 'agent', id as unknown as ObjectId);
  if (!res.ok || isAbsent(res.value)) return { ok: true, value: ABSENT_REF(id) };
  return { ok: true, value: res.value.object };
}

const ABSENT_REF = (id: string): Absent => ({ absent: true, ref: { kind: 'agent', id } });

export async function listAgents(
  ctx: AgentsContext, filter?: ListFilter,
): Promise<Result<Page<AgentDefinitionLite>, StoreError>> {
  const res = await listObjects<AgentDefinitionLite>(ctx.handle, 'agent', filter);
  if (!res.ok) return res;
  return { ok: true, value: { items: res.value.items.map((s) => s.object), ...(res.value.nextCursor ? { nextCursor: res.value.nextCursor } : {}) } };
}

/** Stored version lookup — setModel's CAS read-modify-write needs it. */
export async function agentVersion(ctx: AgentsContext, id: AgentId): Promise<number | null> {
  const res = await getObject<AgentDefinitionLite>(ctx.handle, 'agent', id as unknown as ObjectId);
  if (!res.ok || isAbsent(res.value)) return null;
  return res.value.version;
}

// R3-22: model authority = agents. Def-level setModel is GUARANTEED (AGT-003).
export async function setModel(
  ctx: AgentsContext, id: AgentId, model: string, clientOpId: ClientOpId,
): Promise<Result<AgentDefinitionLite, StoreError>> {
  if (!model) {
    return { ok: false, error: err('InvalidEnvelope', 'model must be a non-empty string',
      { missingFields: ['model'], invalidFields: [{ field: 'model', reason: 'empty' }] }, false) };
  }
  const version = await agentVersion(ctx, id);
  if (version === null) {
    return { ok: false, error: err('NotFound', `no agent with id "${id}"`, { ref: { kind: 'agent', id } }, false) };
  }
  return updateAgent(ctx, id, { model }, version, clientOpId);
}
