// The governed-Agents composition root.
//
// Every public mutation goes through the same three guards, in the same order:
// contract-version check → durable command receipt → the operation itself. A
// caller that retries with the same `clientOpId` gets the same answer instead
// of a second role, a second Agent or a second grant.
import {
  composeReceiptStore,
  type AuthenticatedPrincipal, type B3Result, type CommandContext, type PublicOperationName,
  type ReceiptStore, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  GovernedAgentsContract, CreateRoleProfileInput, UpdateRoleProfileInput,
  CreateAgentFromRoleInput, ResolveLaunchPlanInput, RecordRelationshipInput,
  IssueDelegationGrantInput, ApplyAgentControlInput, RegisterProviderSessionInput,
} from '../contract/api.js';
import type { ProviderAdapterRegistry } from '../contract/providers.js';
import {
  createGovernedAgentsStore, type GovernedAgentsStoreOptions,
} from './store.js';
import { OPERATION, versionGuard, type GovernedAgentsCore } from './context.js';
import {
  createRoleProfile, getRoleProfile, listRoleProfiles, updateRoleProfile,
} from './roles.js';
import { createAgentFromRole, getAgent } from './agents.js';
import { getLaunchPlan, resolveLaunchPlan } from './plans.js';
import { getAgentTree, listChildren, recordRelationship } from './relationships.js';
import {
  authoriseRunOperation, authoriseSpawn, expireGrantsOfRun, issueDelegationGrant,
  listDelegationGrants,
} from './delegation.js';
import { applyAgentControl, discoverAgentControls } from './controls.js';
import { getProviderSession, registerProviderSession } from './sessions.js';
import { continuationAllowed, getControlReplacementPlan } from './continuation.js';
import type { HumanPrincipalId } from '@novakai/foundation/contract';

export interface ComposeGovernedAgentsOptions extends GovernedAgentsStoreOptions {
  readonly providers: ProviderAdapterRegistry;
  /** Whose tree a human/script/Operations spawn lands in. */
  readonly rootHumanPrincipalId?: HumanPrincipalId;
  readonly receipts?: ReceiptStore;
  readonly clock?: () => string;
}

export function composeGovernedAgents(
  options: ComposeGovernedAgentsOptions,
): GovernedAgentsContract {
  const core: GovernedAgentsCore = {
    store: createGovernedAgentsStore(options),
    providers: options.providers,
    rootHumanPrincipalId: options.rootHumanPrincipalId ?? ('person_chris' as HumanPrincipalId),
    clock: options.clock ?? (() => new Date().toISOString()),
  };
  const receipts = options.receipts ?? composeReceiptStore(options);

  /**
   * Everything Agents does is a Foundation mutation keyed by `clientOpId`, so
   * re-entering an interrupted attempt is always safe: there is no PTY and no
   * provider process behind any of these.
   */
  function guarded<Input, Value>(
    operation: PublicOperationName,
    perform: (context: CommandContext, input: Input) => Promise<B3Result<Value>>,
  ) {
    return async (context: CommandContext, input: Input): Promise<B3Result<Value>> => {
      const version = versionGuard<Value>(context);
      if (version) return version;
      return receipts.runCommand(
        context, { operation, request: input, replaySafe: true },
        () => perform(context, input),
      );
    };
  }

  const named = (name: string): PublicOperationName => name as PublicOperationName;

  return {
    createRoleProfile: guarded(named(OPERATION.createRole),
      (context, input: CreateRoleProfileInput) => createRoleProfile(core, context, input)),

    updateRoleProfile: guarded(named(OPERATION.updateRole),
      (context, input: UpdateRoleProfileInput) => updateRoleProfile(core, context, input)),

    createAgentFromRole: guarded(named(OPERATION.createAgent),
      (context, input: CreateAgentFromRoleInput) => createAgentFromRole(core, context, input)),

    resolveLaunchPlan: guarded(named(OPERATION.resolvePlan),
      (context, input: ResolveLaunchPlanInput) => resolveLaunchPlan(core, context, input)),

    recordRelationship: guarded(named(OPERATION.recordRelationship),
      (context, input: RecordRelationshipInput) => recordRelationship(core, context, input)),

    issueDelegationGrant: guarded(named(OPERATION.issueGrant),
      (context, input: IssueDelegationGrantInput) => issueDelegationGrant(core, context, input)),

    applyAgentControl: guarded(named(OPERATION.applyControl),
      (context, input: ApplyAgentControlInput) => applyAgentControl(core, context, input)),

    async registerProviderSession(
      context: SystemCommandContext<'sys_agent_runtime'>, input: RegisterProviderSessionInput,
    ) {
      const version = versionGuard<never>(context);
      if (version) return version;
      return receipts.runCommand(
        context, { operation: named(OPERATION.registerSession), request: input, replaySafe: true },
        () => registerProviderSession(core, context, input),
      );
    },

    listDelegationGrants: (principal, filter) => listDelegationGrants(core, principal, filter),

    expireGrantsOfRun: (context, agentRunId) =>
      expireGrantsOfRun(core, context, agentRunId),

    getAgent: (principal, agentId) => getAgent(core, principal, agentId),
    getRoleProfile: (principal, roleProfileId) => getRoleProfile(core, principal, roleProfileId),
    listRoleProfiles: (principal) => listRoleProfiles(core, principal),
    getLaunchPlan: (principal, launchPlanId) => getLaunchPlan(core, principal, launchPlanId),
    getAgentTree: (principal, input) => getAgentTree(core, principal, input),
    listChildren: (principal, parentAgentId) => listChildren(core, principal, parentAgentId),
    getProviderSession: (principal, id) => getProviderSession(core, principal, id),
    discoverAgentControls: (principal, input) => discoverAgentControls(core, principal, input),
    authoriseSpawn: (principal: AuthenticatedPrincipal, input) =>
      authoriseSpawn(core, principal, input),
    authoriseRunOperation: (principal, input) => authoriseRunOperation(core, principal, input),
    continuationAllowed: (principal, input) => continuationAllowed(core, principal, input),
    getControlReplacementPlan: (principal, planId) =>
      getControlReplacementPlan(core, principal, planId),
  };
}
