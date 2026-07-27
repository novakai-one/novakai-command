// packages/agents/contract — Pass 2 §5 (agents-lite) + §2.1 terminal mini-contract
// payloads (R3-15) + §6 agents error shapes. Foundation owns envelope/brands;
// this package re-uses them (never redefines) via the foundation contract path.
import { z } from 'zod';

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

// ── Terminal mini-contract payloads (R3-15: exactly five ops; model-switch excluded) ──
export const SpawnOpts = z.object({
  model: z.string().min(1).optional(),
  cwd: z.string().optional(),
  argv: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
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
