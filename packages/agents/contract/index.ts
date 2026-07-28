// packages/agents/contract — the ONLY legal import surface for consumers.
export * from './schemas.js';
export * from './errors.js';
export { composeAgents, mockOf, type AgentsContext, type ComposeAgentsOptions } from '../core/composition.js';
export { createAgentsContract, type AgentsContract } from '../core/contract.js';
export { createMockAdapter, type MockTerminalAdapter } from '../core/providers/mock.js';
export { createTerminalAdapter } from '../core/providers/terminal.js';
// B1 DEC-B1-4: the kimi provider adapter now lives inside the capability that
// owns providers (red gate C1). The server composes it; nobody else builds one.
export {
  createKimiCliRuntime, defaultKimiCliPath,
  type KimiCliRuntime, type KimiCliRuntimeOptions, type KimiTurnRecord,
} from '../core/providers/kimi.js';
export type { TerminalAdapter, TerminalRuntimeLike, SpawnedSession } from '../core/providers/adapter.js';
export type { LiveLaneSender, LiveLaneBinding } from '../core/live-lane/liveLane.js';
export type { RegisterSkillInput } from '../core/skills/skills.js';
export type { DefineAgentInput } from '../core/registry/registry.js';
