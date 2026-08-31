/**
 * Host doorway for the Agents capability.
 *
 * This module carries ONLY the names an outside consumer (packages/server,
 * packages/shell) actually imports. Everything else is imported from the
 * module that owns it: contract/schemas.ts, contract/errors.ts,
 * contract/provider-turn.ts, contract/provider-usage-evidence.ts, core/ and
 * cli/. The governed-team surface (roles, launch plans, grants) has its own
 * door at ../governed/contract/index.ts.
 */

/** Production composition: store handle, provider adapters and event bus in one context. */
export { composeAgents } from '../core/composition.js';

/** Test seam: reach the mock provider's scripting helpers off a composed context. */
export { mockOf } from '../core/composition.js';

/** The consumer-facing Agents interface, bound to a composed context. */
export { createAgentsContract, type AgentsContract } from '../core/contract.js';

/** The print-mode CLI runtimes, one per provider; the server composes them, nobody else builds one. */
export { createKimiCliRuntime, defaultKimiCliPath, type KimiCliRuntime } from '../core/providers/kimi.js';
export { createClaudeCliRuntime, defaultClaudeCliPath } from '../core/providers/claude.js';
export { createCodexCliRuntime, defaultCodexCliPath } from '../core/providers/codex.js';

/** What a provider CLI runtime is, and the record one completed turn leaves behind. */
export type { ProviderCliRuntime, ProviderTurnRecord } from '../core/providers/adapter.js';

/**
 * The providerSession registry — Agents owns the kind and is its sole writer;
 * the server drives it from the composition root.
 */
export {
  createProviderSessionRegistry, type ProviderSessionRegistry,
} from '../core/sessions/registry.js';
export type { ProviderSessionRecord } from '../core/sessions/record-shape.js';
export { osProcessProbe, type ProcessProbe } from '../core/sessions/process-probe.js';

/** Locating and reading provider transcripts without learning any provider's on-disk layout. */
export {
  findProviderTranscriptCandidates,
  parseProviderTranscriptLines,
  providerHasTranscript,
  providerTranscriptRoots,
  sanitizeProviderCwd,
  type ProviderTranscriptUsage,
} from '../core/providers/transcript.js';

/** Boundary readers a host transport runs over usage-evidence payloads. */
export {
  parseEnsureProviderTurnCompletionEvidenceInput,
  parseProviderTurnCompletionEvidenceFilter,
  type ProviderUsageEvidenceContract,
} from './provider-usage-evidence.js';

/** Production composition for the provider usage-evidence store. */
export { composeProviderUsageEvidence } from '../core/provider-usage-evidence.js';
