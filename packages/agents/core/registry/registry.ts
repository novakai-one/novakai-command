// core/registry — agent definitions v2 in agents.jsonl via the foundation
// scoped handle (kind 'agent'; the SCOPE CHECK lives in foundation's contract
// layer (api.ts scopeCheck) — the engine performs no scope check; M3 audit
// correction, DEC-S2-14). Envelope/trace laws are foundation's; this module
// shapes the agent payload (AGT-004) and normalizes S1 lite defs on read
// (DEC-F10 lazy upgrade — stored lines are never rewritten).
import { randomUUID } from 'node:crypto';
import {
  createObject, getObject, listObjects, updateObject,
} from '@novakai/foundation/dist/contract/index.js';
import type { AgentId, ClientOpId, ObjectId } from '@novakai/foundation/dist/contract/brands.js';
import type { Absent, Page, ListFilter, Result } from '@novakai/foundation/dist/contract/types.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
import { err } from '@novakai/foundation/dist/contract/errors.js';
import {
  AgentDefinition, HookInput,
  type AgentDefinitionT, type HookAction, type HookInput as HookInputT,
} from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';

export type DefineAgentInput = {
  displayName: string;
  provider: AgentDefinitionT['provider'];
  model: string;
  instructions?: string;
  hooks?: HookInputT[];
  skills?: string[];
  permissionLevel?: AgentDefinitionT['permissionLevel'];
  status?: AgentDefinitionT['status'];
  origin?: AgentDefinitionT['origin'];
  parentAgentId?: string;
};

/**
 * DEC-F10 upgrade-on-read: an S1 lite def (hooks = placeholder Ref[], no
 * skills/instructions) normalizes to v2 in memory. Placeholder Ref hooks are
 * uninterpretable as subscriptions → empty list (recorded in NOTES.md).
 */
export function normalizeAgent(flat: unknown): AgentDefinitionT | null {
  if (flat === null || typeof flat !== 'object' || Array.isArray(flat)) return null;
  const obj = flat as Record<string, unknown>;
  const hooks = Array.isArray(obj.hooks)
    ? obj.hooks.filter((h) => h !== null && typeof h === 'object' && 'event' in (h as object))
    : [];
  const parsed = AgentDefinition.safeParse({
    ...obj,
    origin: typeof obj.origin === 'string' ? obj.origin : 'nvk-spawned',
    sessions: Array.isArray(obj.sessions) ? obj.sessions : [],
    instructions: typeof obj.instructions === 'string' ? obj.instructions : '',
    skills: Array.isArray(obj.skills) ? obj.skills : [],
    hooks,
  });
  return parsed.success ? parsed.data : null;
}

function stampHooks(input: HookInputT[] | undefined): AgentDefinitionT['hooks'] {
  return (input ?? []).map((h) => ({
    id: `hook_${randomUUID()}`,
    event: h.event,
    action: h.action,
    createdAt: new Date().toISOString(),
  }));
}

export async function defineAgent(
  ctx: AgentsContext, def: DefineAgentInput, clientOpId: ClientOpId,
): Promise<Result<AgentDefinitionT, StoreError>> {
  const id = `agent_${randomUUID()}` as AgentId;
  const record: AgentDefinitionT = {
    kind: 'agent',
    id,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: def.permissionLevel ?? 'private',
    createdBy: 'overridden-by-foundation', // red gate 4: foundation stamps the token principal
    displayName: def.displayName,
    provider: def.provider,
    model: def.model,
    origin: def.origin ?? 'nvk-spawned',
    ...(def.parentAgentId === undefined ? {} : { parentAgentId: def.parentAgentId }),
    sessions: [],
    instructions: def.instructions ?? '',
    hooks: stampHooks(def.hooks),
    skills: def.skills ?? [],
    status: def.status ?? 'defined',
  };
  // validate every hook input against the closed sets (events + v1 actions).
  // M8: typed InvalidEnvelope like attachHook — never a raw ZodError throw.
  for (const h of def.hooks ?? []) {
    const parsed = HookInput.safeParse(h);
    if (!parsed.success) {
      return {
        ok: false,
        error: err('InvalidEnvelope',
          `hook rejected: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          { missingFields: [], invalidFields: parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', reason: i.message })) }, false),
      };
    }
  }
  const res = await createObject<AgentDefinitionT>(ctx.handle, AgentDefinition.parse(record), clientOpId);
  if (!res.ok) return res;
  return { ok: true, value: res.value.object };
}

export async function updateAgent(
  ctx: AgentsContext, id: AgentId, patch: Partial<AgentDefinitionT>,
  expectedVersion: number, clientOpId: ClientOpId,
): Promise<Result<AgentDefinitionT, StoreError>> {
  const res = await updateObject<AgentDefinitionT>(ctx.handle, id as unknown as ObjectId, patch, expectedVersion, clientOpId);
  if (!res.ok) return res;
  const normalized = normalizeAgent(res.value.object);
  if (!normalized) {
    return { ok: false, error: err('InvalidEnvelope', `agent "${id}" failed v2 normalization after update`, { missingFields: [], invalidFields: [{ field: '(root)', reason: 'v2 normalization failed' }] }, false) };
  }
  return { ok: true, value: normalized };
}

export async function getAgent(
  ctx: AgentsContext, id: AgentId,
): Promise<Result<AgentDefinitionT | Absent, never>> {
  const res = await getObject<AgentDefinitionT>(ctx.handle, 'agent', id as unknown as ObjectId);
  if (!res.ok || isAbsent(res.value)) return { ok: true, value: ABSENT_REF(id) };
  const normalized = normalizeAgent(res.value.object);
  if (!normalized) return { ok: true, value: ABSENT_REF(id) };
  return { ok: true, value: normalized };
}

const ABSENT_REF = (id: string): Absent => ({ absent: true, ref: { kind: 'agent', id } });

export async function listAgents(
  ctx: AgentsContext, filter?: ListFilter,
): Promise<Result<Page<AgentDefinitionT>, StoreError>> {
  const res = await listObjects<AgentDefinitionT>(ctx.handle, 'agent', filter);
  if (!res.ok) return res;
  const items = res.value.items
    .map((s) => normalizeAgent(s.object))
    .filter((a): a is AgentDefinitionT => a !== null);
  return { ok: true, value: { items, ...(res.value.nextCursor ? { nextCursor: res.value.nextCursor } : {}) } };
}

/** Stored version lookup — CAS read-modify-write (setModel, attachHook) needs it. */
export async function agentVersion(ctx: AgentsContext, id: AgentId): Promise<number | null> {
  const res = await getObject<AgentDefinitionT>(ctx.handle, 'agent', id as unknown as ObjectId);
  if (!res.ok || isAbsent(res.value)) return null;
  return res.value.version;
}

// R3-22: model authority = agents. Def-level setModel is GUARANTEED (AGT-003).
export async function setModel(
  ctx: AgentsContext, id: AgentId, model: string, clientOpId: ClientOpId,
): Promise<Result<AgentDefinitionT, StoreError>> {
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

/** attachHook = one single-object mutation appending a subscription (R3-18). */
export async function attachHook(
  ctx: AgentsContext, id: AgentId, input: HookInputT, clientOpId: ClientOpId,
): Promise<Result<AgentDefinitionT, StoreError>> {
  const parsed = HookInput.safeParse(input); // closed sets: 4 events × 2 actions
  if (!parsed.success) {
    return {
      ok: false,
      error: err('InvalidEnvelope',
        `hook rejected: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        { missingFields: [], invalidFields: parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', reason: i.message })) }, false),
    };
  }
  const current = await getAgent(ctx, id);
  if (!current.ok || isAbsent(current.value)) {
    return { ok: false, error: err('NotFound', `no agent with id "${id}"`, { ref: { kind: 'agent', id } }, false) };
  }
  const version = await agentVersion(ctx, id);
  if (version === null) {
    return { ok: false, error: err('NotFound', `no agent with id "${id}"`, { ref: { kind: 'agent', id } }, false) };
  }
  const hooks = [...current.value.hooks, ...stampHooks([parsed.data])]; // creation order = array order
  return updateAgent(ctx, id, { hooks }, version, clientOpId);
}

export async function detachHook(
  ctx: AgentsContext, id: AgentId, hookId: string, clientOpId: ClientOpId,
): Promise<Result<AgentDefinitionT, StoreError>> {
  const current = await getAgent(ctx, id);
  if (!current.ok || isAbsent(current.value)) {
    return { ok: false, error: err('NotFound', `no agent with id "${id}"`, { ref: { kind: 'agent', id } }, false) };
  }
  if (!current.value.hooks.some((h) => h.id === hookId)) {
    return { ok: false, error: err('NotFound', `agent "${id}" has no hook "${hookId}"`, { ref: { kind: 'agent', id } }, false) };
  }
  const version = await agentVersion(ctx, id);
  if (version === null) {
    return { ok: false, error: err('NotFound', `no agent with id "${id}"`, { ref: { kind: 'agent', id } }, false) };
  }
  return updateAgent(ctx, id, { hooks: current.value.hooks.filter((h) => h.id !== hookId) }, version, clientOpId);
}
