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
// B1b DEC-B1-4: the codex adapter. `codex exec` per message, resume via
// `codex exec resume <thread_id>` (OD-B1-1 CLOSED — the mechanism exists and
// is verified live), no mid-session model switch (typed UnsupportedOperation).
export {
  createCodexCliRuntime, defaultCodexCliPath, isInsideGitRepo,
  type CodexCliRuntime, type CodexCliRuntimeOptions,
} from '../core/providers/codex.js';
// B1b DEC-B1-4: the claude adapter. `claude -p` per message, resume via
// `--resume <session_id>`, no mid-session model switch.
export {
  createClaudeCliRuntime, defaultClaudeCliPath,
  type ClaudeCliRuntime, type ClaudeCliRuntimeOptions,
} from '../core/providers/claude.js';
export type {
  TerminalAdapter, TerminalRuntimeLike, SpawnedSession,
  ProviderCliRuntime, ProviderTurnRecord, ProviderTurnUsage,
} from '../core/providers/adapter.js';
export type { LiveLaneSender, LiveLaneBinding } from '../core/live-lane/liveLane.js';
// B1 DEC-B1-6: the providerSession registry — agents owns the kind and is its
// sole writer; the server drives it from the composition root.
export {
  createProviderSessionRegistry, osProcessProbe,
  type ProviderSessionRegistry, type ProviderSessionRecord, type ProviderSessionStatus,
  type RegisterSessionInput, type SweepResult, type ProcessProbe,
} from '../core/sessions/registry.js';
export type { RegisterSkillInput } from '../core/skills/skills.js';
export type { DefineAgentInput } from '../core/registry/registry.js';
