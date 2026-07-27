// packages/agents/contract — the ONLY legal import surface for consumers.
export * from './schemas.js';
export * from './errors.js';
export { composeAgents, mockOf, type AgentsContext, type ComposeAgentsOptions } from '../core/composition.js';
export { createAgentsContract, type AgentsContract } from '../core/contract.js';
export { createMockAdapter, type MockTerminalAdapter } from '../core/providers/mock.js';
export { createTerminalAdapter } from '../core/providers/terminal.js';
export type { TerminalAdapter, TerminalRuntimeLike, SpawnedSession } from '../core/providers/adapter.js';
export type { LiveLaneSender, LiveLaneBinding } from '../core/live-lane/liveLane.js';
