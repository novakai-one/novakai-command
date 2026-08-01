// packages/agent-runtime/contract — the ONLY legal import surface.
//
// B3a scope: the Runtime HOST. Who owns this machine's Novakai runtime, which
// epoch is active, and what is honestly true after a restart. Agent Runs,
// roles, family and delegation arrive in B3b and do not reopen this door.
export * from './types.js';
export { composeRuntimeHost, type ComposeRuntimeHostOptions } from '../core/compose.js';
export { createFileInstanceLease } from '../adapters/file-lease.js';
