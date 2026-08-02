// packages/agent-runtime/contract — the ONLY legal import surface.
//
// Two capabilities live behind this door, and they are genuinely different
// things. The HOST answers "who owns this machine's runtime, which epoch is
// active, what is true after a restart". RUNS answers "what is this Agent
// doing, who replaced it, who supervises it, and what happened to the spawn
// that got interrupted".
export * from './types.js';
export { composeRuntimeHost, type ComposeRuntimeHostOptions } from '../core/compose.js';
export { createFileInstanceLease } from '../adapters/file-lease.js';
export * from './validate.js';
// B3b: governed Runs, family, delegation, continuation, supervision.
export * from './runs.js';
export * from './runs-api.js';
export * from './ports.js';
export {
  composeAgentRuns, type ComposeAgentRunsOptions, type ComposedAgentRuns,
} from '../core/runs-compose.js';
export type { InboxDeliveryPass, InboxDeliveryPump } from '../core/inbox-delivery.js';
export { RUNTIME_KINDS } from '../core/runs-store.js';
export { canonicalTokens, confirmationPrompt, judge, workPrompt } from '../core/gate.js';
export { effectKeyFor } from '../core/journal.js';
export { stopTreeToken } from '../core/stop-tree.js';
export * from './runs-validate.js';
