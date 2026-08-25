// packages/agents/contract — Pass 2 §5 (agents-lite) + §2.1 terminal mini-contract
// payloads (R3-15) + §6 agents error shapes. Foundation owns envelope/brands;
// this package re-uses them (never redefines) via the foundation contract path.
import { z } from 'zod';
import { PermissionLevel } from '@novakai/foundation/dist/contract/schemas.js';

// Re-exported so consumers import ONE door.
export {
  AgentDefinitionLite,
  type AgentDefinitionLite as AgentDefinitionLiteT,
} from '@novakai/foundation/dist/contract/schemas.js';
export type {
  AgentId, SessionId, ClientOpId,
} from '@novakai/foundation/dist/contract/brands.js';
export type {
  Result, Absent, Page, ListFilter, StoredObject,
} from '@novakai/foundation/dist/contract/types.js';
export type { StoreError, ContractError } from '@novakai/foundation/dist/contract/errors.js';

export const ProviderName = z.enum(['kimi', 'claude', 'codex', 'mock']);
export type ProviderName = z.infer<typeof ProviderName>;

/** How the durable Agent first entered Novakai. */
export const AgentOrigin = z.enum(['nvk-spawned', 'provider-spawned', 'agent-spawned']);
export type AgentOrigin = z.infer<typeof AgentOrigin>;

// ── Agent definition v2 (S2a: AGT-004, DEC-S2-1, §22 ruling 4) ──────────────
// permissionLevel = the ENVELOPE field only; the def carries no permission
// field of its own. No provider-specific fields (red gate S2-8).
export const HookEvent = z.enum(['onSpawn', 'onMessagePre', 'onMessagePost', 'onExit']);
export type HookEvent = z.infer<typeof HookEvent>;

// v1 actions = exactly two (DEC-S2-2; everything else is S3+).
export const HookAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('log-to-trace'), message: z.string().default('') }),
  z.object({ kind: z.literal('inject-context-text'), text: z.string().min(1) }),
]);
export type HookAction = z.infer<typeof HookAction>;

// Subscriptions live ON the agent object (R3-18 single-object mutation);
// execution order = array order = creation order (§22 ruling 2).
export const HookSubscription = z.object({
  id: z.string().min(1), // hook_<uuid>, stamped by the registry
  event: HookEvent,
  action: HookAction,
  createdAt: z.string().datetime(),
});
export type HookSubscription = z.infer<typeof HookSubscription>;

/** What defineAgent/attachHook accept — id/createdAt are system-stamped. */
export const HookInput = z.object({ event: HookEvent, action: HookAction });
export type HookInput = z.infer<typeof HookInput>;

export const AgentDefinition = z.object({
  kind: z.literal('agent'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: PermissionLevel,
  createdBy: z.string().min(1),
  displayName: z.string().min(1),
  provider: ProviderName,
  model: z.string().min(1),
  origin: AgentOrigin.default('nvk-spawned'),
  parentAgentId: z.string().min(1).optional(),
  /** Current Messaging ProviderSession pointer; never a PTY/runtime key. */
  sessionId: z.string().min(1).optional(),
  /** Prior ProviderSession pointers, oldest first and unique. */
  sessions: z.array(z.string().min(1)).default([]),
  instructions: z.string().default(''),   // provider-neutral system-prompt text
  hooks: z.array(HookSubscription).default([]),
  skills: z.array(z.string().min(1)).default([]), // skill id refs (DEC-S2-4)
  status: z.enum(['defined', 'archived']).default('defined'),
});
export type AgentDefinitionT = z.infer<typeof AgentDefinition>;

// ── Skills registry (S2a: DEC-S2-4, §22 ruling 5) ───────────────────────────
// Registry records hold path refs to skill dirs; v1 never parses/executes.
export const SkillDefinition = z.object({
  kind: z.literal('skill'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: PermissionLevel,
  createdBy: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1), // path ref to the skill directory
  description: z.string().default(''),
});
export type SkillDefinitionT = z.infer<typeof SkillDefinition>;

// ── Terminal mini-contract payloads (R3-15: exactly five ops; model-switch excluded) ──
export const SpawnOpts = z.object({
  model: z.string().min(1).optional(),
  cwd: z.string().optional(),
  argv: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  /** S2a (§22 ruling 5): resolved skill DIR paths the adapter must make
   * available to the spawned session via the provider's declared mechanism. */
  skills: z.array(z.string()).optional(),
}).default({});
export type SpawnOpts = z.infer<typeof SpawnOpts>;

export const SpawnRequest = z.object({
  clientOpId: z.string().min(1),
  provider: ProviderName,
  agentId: z.string().min(1),
  opts: SpawnOpts,
});
export type SpawnRequest = z.infer<typeof SpawnRequest>;

export const SpawnResponse = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type SpawnResponse = z.infer<typeof SpawnResponse>;

// PtyEvent — raw terminal truth (terminal owns it; agents re-publishes, R3-17)
export const PtyEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('spawned'), sessionId: z.string(), at: z.string().datetime(), pid: z.number().int() }),
  z.object({ type: z.literal('output'), sessionId: z.string(), at: z.string().datetime(), data: z.string() }),
  z.object({ type: z.literal('activity'), sessionId: z.string(), at: z.string().datetime(), activity: z.string() }),
  z.object({ type: z.literal('exited'), sessionId: z.string(), at: z.string().datetime(), code: z.number().int().nullable(), signal: z.string().nullable() }),
]);
export type PtyEvent = z.infer<typeof PtyEvent>;

// AgentEvent — agents OWNS the public event (R3-17, R3-1). Shell consumes only this.
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('spawned'), agentId: z.string(), sessionId: z.string(), at: z.string().datetime() }),
  z.object({ type: z.literal('online'), agentId: z.string(), sessionId: z.string(), at: z.string().datetime() }),
  z.object({ type: z.literal('activity'), agentId: z.string(), sessionId: z.string(), at: z.string().datetime(), activity: z.string() }),
  z.object({
    type: z.literal('offline'), agentId: z.string(), sessionId: z.string(), at: z.string().datetime(),
    reason: z.enum(['exited', 'provider_error', 'closed']),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export type Unsubscribe = () => void;
