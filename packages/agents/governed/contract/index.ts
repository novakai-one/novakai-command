/**
 * Host doorway for governed Agents: roles, launch plans, the family tree,
 * delegation grants and provider controls behind one contract.
 *
 * This module carries ONLY the names an outside consumer (packages/server)
 * actually imports. Everything else is imported from the module that owns
 * it: contract/records.ts, contract/api.ts, contract/providers.ts,
 * contract/validate.ts, core/ and adapters/.
 */

/** The durable governed records a host may read: the individual, its role, a grant, a pinned plan. */
export type {
  Agent, AgentRoleProfile, DelegationGrant, ProviderKind, ResolvedLaunchPlan,
} from './records.js';

/** The full governed command/query surface the composition root returns. */
export type { GovernedAgentsContract } from './api.js';

/** One interactive provider CLI, and the per-provider registry of them. */
export type { InteractiveProviderAdapter, ProviderAdapterRegistry } from './providers.js';

/** Boundary readers a host transport runs over raw command payloads before calling in. */
export {
  readCreateRoleProfileInput,
  readIssueDelegationGrantInput,
  readUpdateRoleProfileInput,
} from './validate.js';

/** Production composition: store, command receipts and provider adapters behind the contract. */
export { composeGovernedAgents } from '../core/compose.js';

/** The authority scopes every local human principal holds. */
export { HUMAN_SCOPES } from '../core/context.js';

/** Wires the three installed provider CLIs into one adapter registry. */
export { createProviderAdapters } from '../adapters/providers/index.js';

/** Deterministic provider stand-ins for contract suites — the same seam as the real CLIs. */
export { createFakeProviderAdapters } from '../adapters/providers/fake.js';
