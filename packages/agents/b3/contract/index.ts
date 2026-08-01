// packages/agents/b3/contract — the governed-team door.
//
// Consumers import this and nothing deeper. The private core stays private:
// roles, plans, family, grants and controls are behaviour behind one contract,
// not a set of modules to be assembled by whoever calls them.
export * from './records.js';
export * from './api.js';
export * from './providers.js';
export {
  readAgentControl, readAuthoriseSpawnInput, readCreateAgentFromRoleInput,
  readCreateRoleProfileInput, readIssueDelegationGrantInput,
  readRecordRelationshipInput, readRegisterProviderSessionInput,
  readResolveLaunchPlanInput, readUpdateRoleProfileInput,
  LAUNCH_CONFIGURATION_MODES,
} from './validate.js';
export {
  composeGovernedAgents, type ComposeGovernedAgentsOptions,
} from '../core/compose.js';
export {
  SCOPE, HUMAN_SCOPES, RUN_OPERATION_SCOPE,
} from '../core/context.js';
export { GOVERNED_AGENT_KINDS } from '../core/store.js';
export {
  createFakeProviderAdapter, createFakeProviderAdapters, findMarkerLine,
  type FakeProviderOptions,
} from '../adapters/providers/fake.js';
export {
  createProviderAdapters, createClaudeAdapter, createCodexAdapter, createKimiAdapter,
  type ClaudeAdapterOptions, type CodexAdapterOptions, type KimiAdapterOptions,
  type ProviderAdapterOptions,
} from '../adapters/providers/index.js';
