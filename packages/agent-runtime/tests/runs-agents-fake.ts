// The Agents fake.
//
// It is not a stub: it enforces the rules the Runtime actually depends on —
// a role may only spawn the child roles it names, a grant may not widen, an
// unknown role is refused — because a Runtime tested against a permissive fake
// is a Runtime nobody tested.
import {
  b3err, b3fail, b3ok, mintAgentRunId, mintObjectId, mintResolvedLaunchPlanId,
  type AgentId, type AgentRoleProfileId, type AgentRunId, type AuthorityScope,
  type B3Result, type DelegationGrantId, type HumanPrincipalId,
  type ProviderSessionId, type ResolvedLaunchPlanId,
} from '@novakai/foundation/contract';
import type { AgentFacts, AgentsPort, LaunchPlanFacts } from '../contract/ports.js';

export const CHRIS = 'person_chris' as HumanPrincipalId;
export const EVERY_SCOPE = [
  'agent.spawn', 'agent.interrupt', 'agent.stop-one', 'agent.stop-tree',
  'agent.adopt', 'agent.continue', 'agent.control',
  'supervision:watch:start-turn',
] as AuthorityScope[];

// ── A fake Agents that behaves like the real one where it matters ───────────

export interface FakeAgents extends AgentsPort {
  readonly roles: Map<AgentRoleProfileId, { childRoles: readonly AgentRoleProfileId[] }>;
  readonly agents: Map<AgentId, AgentFacts & { parentAgentId?: AgentId }>;
  readonly plans: Map<ResolvedLaunchPlanId, LaunchPlanFacts>;
  readonly sessions: Map<ProviderSessionId, { native: string; discovered: boolean }>;
  readonly grantsIssued: { readonly issuerAgentRunId: AgentRunId; readonly scopes: readonly AuthorityScope[] }[];
  readonly expiredRuns: AgentRunId[];
  /** Every control that reached Agents, in order — what the Runtime forwarded. */
  readonly controlsApplied: { readonly name: string; readonly value: string }[];
  /** Every scope the NEXT authorisation may return; empty means "denied". */
  allowedScopes: readonly AuthorityScope[];
  /** Force one refusal, so a test can be about that refusal. */
  refuseNext: { operation: string; error: ReturnType<typeof b3err> } | null;
  defineRole(name: string, childRoles?: readonly AgentRoleProfileId[]): AgentRoleProfileId;
  planOf(agentId: AgentId): LaunchPlanFacts;
}

export interface FakeAgentsOptions {
  readonly gateMode?: 'required-two-turn' | 'disabled';
  readonly allowedContinuationModes?: LaunchPlanFacts['lifecyclePolicy']['allowedContinuationModes'];
  readonly onSupervisorFinal?: LaunchPlanFacts['lifecyclePolicy']['onSupervisorFinal'];
  readonly skills?: LaunchPlanFacts['skills'];
  readonly supervisionPolicy?: LaunchPlanFacts['supervisionPolicy'];
}

export function createFakeAgents(options: FakeAgentsOptions = {}): FakeAgents {
  const roles = new Map<AgentRoleProfileId, { childRoles: readonly AgentRoleProfileId[] }>();
  const agents = new Map<AgentId, AgentFacts & { parentAgentId?: AgentId }>();
  const plans = new Map<ResolvedLaunchPlanId, LaunchPlanFacts>();
  const sessions = new Map<ProviderSessionId, { native: string; discovered: boolean }>();
  const grantsIssued: FakeAgents['grantsIssued'] = [];
  const expiredRuns: AgentRunId[] = [];
  const controlsApplied: FakeAgents['controlsApplied'] = [];
  const skills = options.skills ?? [{ id: 'tdd', version: 1, digest: 'digest-tdd' }];

  /** Which role this Agent stands on, so its plan carries that role's policy. */
  const planRoleOf = (agentId: AgentId): AgentRoleProfileId =>
    agents.get(agentId)?.roleProfileId ?? ('' as AgentRoleProfileId);

  const planFor = (agentId: AgentId): LaunchPlanFacts => ({
    id: mintResolvedLaunchPlanId(),
    agentId,
    provider: 'claude',
    modelId: 'opus',
    effort: 'high',
    workingDirectory: '/tmp/work',
    skills,
    skillsConfirmationGate: options.gateMode === 'disabled'
      ? { mode: 'disabled' }
      : {
        mode: 'required-two-turn',
        confirmationMarker: 'SKILLS-CONFIRMED:',
        onFailure: 'terminate-run-and-record-drift',
      },
    ...(options.supervisionPolicy === undefined
      ? {} : { supervisionPolicy: options.supervisionPolicy }),
    lifecyclePolicy: {
      onSupervisorFinal: options.onSupervisorFinal ?? 'assign-nearest-live-ancestor',
      allowedContinuationModes: options.allowedContinuationModes
        ?? ['resume', 'fresh', 'compact', 'handover'],
    },
    spawnPolicy: { allowedChildRoleIds: roles.get(planRoleOf(agentId))?.childRoles ?? [] },
  });

  const port: FakeAgents = {
    roles,
    agents,
    plans,
    sessions,
    grantsIssued,
    expiredRuns,
    controlsApplied,
    allowedScopes: EVERY_SCOPE,
    refuseNext: null,

    defineRole(name, childRoles = []) {
      const id = `agentRole_${mintAgentRunId().replace('agentRun_', '')}` as AgentRoleProfileId;
      roles.set(id, { childRoles });
      void name;
      return id;
    },

    planOf(agentId) {
      const held = [...plans.values()].find((plan) => plan.agentId === agentId);
      return held ?? planFor(agentId);
    },

    async authoriseSpawn(principal, input) {
      const refused = refusal(port, 'spawn');
      if (refused) return refused;
      if (!roles.has(input.roleProfileId)) {
        return b3fail(b3err('RoleNotAllowed', 'unknown role',
          { roleProfileId: input.roleProfileId }, false));
      }
      if (principal.kind === 'agent-run') {
        const parent = input.callerAgentId;
        if (parent === undefined) {
          return b3fail(b3err('PermissionDenied', 'no caller agent',
            { operation: 'agent.spawn' }, false));
        }
        const parentRole = agents.get(parent)?.roleProfileId;
        const permitted = parentRole !== undefined
          && (roles.get(parentRole)?.childRoles ?? []).includes(input.roleProfileId);
        if (!permitted) {
          return b3fail(b3err('RoleNotAllowed', 'that role may not be spawned here',
            { roleProfileId: input.roleProfileId, parentAgentId: parent }, false));
        }
        return b3ok({
          rootHumanPrincipalId: agents.get(parent)!.rootHumanPrincipalId,
          parentAgentId: parent,
          launchSurface: 'agent',
        });
      }
      if (!principal.verifiedScopes.includes('agent.spawn' as AuthorityScope)) {
        return b3fail(b3err('PermissionDenied', 'no spawn scope',
          { operation: 'agent.spawn' }, false));
      }
      return b3ok({ rootHumanPrincipalId: CHRIS, launchSurface: 'novakai-shell' });
    },

    async authoriseRunOperation(principal, input) {
      const refused = refusal(port, input.operation);
      if (refused) return refused;
      const required = `agent.${input.operation}` as AuthorityScope;
      const held = principal.kind === 'agent-run' ? port.allowedScopes : principal.verifiedScopes;
      if (!held.includes(required)) {
        return b3fail(b3err('PermissionDenied', `no ${required} scope`,
          { operation: required, requiredScope: required }, false));
      }
      void input.targetAgentId;
      return b3ok({});
    },

    async createAgentFromRole(context, input) {
      const refused = refusal(port, 'createAgent');
      if (refused) return refused;
      const agent: AgentFacts & { parentAgentId?: AgentId } = {
        id: mintObjectId('agent') as unknown as AgentId,
        displayName: input.displayName,
        roleProfileId: input.roleProfileId,
        rootHumanPrincipalId: input.rootHumanPrincipalId,
        status: 'active',
        ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
      };
      agents.set(agent.id, agent);
      void context;
      return b3ok({ agent });
    },

    async resolveLaunchPlan(context, input) {
      const refused = refusal(port, 'resolvePlan');
      if (refused) return refused;
      void context;
      if (input.configurationMode === 'inherit-plan' && input.inheritedPlanId !== undefined) {
        const held = plans.get(input.inheritedPlanId);
        if (held) return b3ok(held);
      }
      const plan = { ...planFor(input.agentId), workingDirectory: input.workingDirectory };
      plans.set(plan.id, plan);
      return b3ok(plan);
    },

    async getLaunchPlan(_principal, launchPlanId) {
      const held = plans.get(launchPlanId);
      if (!held) {
        return b3fail(b3err('LaunchPlanInvalid', 'no such plan', { issues: [] }, false));
      }
      return b3ok(held);
    },

    async getAgent(_principal, agentId) {
      const held = agents.get(agentId);
      if (!held) return b3fail(b3err('UnknownAgent', 'no such agent', { agentId }, false));
      return b3ok(held);
    },

    async listChildRelationships(_principal, parentAgentId) {
      return b3ok([...agents.values()]
        .filter((agent) => agent.parentAgentId === parentAgentId)
        .map((agent) => ({
          id: `rel_${parentAgentId}_${agent.id}`,
          kind: 'agentRelationship' as const,
          rootHumanPrincipalId: 'person_chris' as never,
          parentAgentId,
          childAgentId: agent.id,
          createdFromRunId: 'agentRun_fake' as never,
        })));
    },

    async parentAgentIdOf(_principal, agentId) {
      return b3ok(agents.get(agentId)?.parentAgentId ?? null);
    },

    async issueDelegationGrant(_context, input) {
      const widened = input.requestedScopes.filter(
        (scope) => !port.allowedScopes.includes(scope),
      );
      if (widened.length > 0) {
        return b3fail(b3err('AuthorityEscalation', 'cannot widen',
          { requestedScopes: input.requestedScopes, allowedScopes: port.allowedScopes }, false));
      }
      grantsIssued.push({
        issuerAgentRunId: input.issuerAgentRunId, scopes: input.requestedScopes,
      });
      return b3ok({ id: `delegationGrant_${mintAgentRunId().replace('agentRun_', '')}` as DelegationGrantId });
    },

    async expireGrantsOfRun(agentRunId) {
      expiredRuns.push(agentRunId);
      return b3ok({ expired: [] });
    },

    async registerProviderSession(input) {
      const refused = refusal(port, 'registerSession');
      if (refused) return refused;
      sessions.set(input.expectedProviderSessionId, {
        native: input.providerResumeHandle ?? '',
        discovered: input.discovery.state === 'discovered',
      });
      return b3ok({
        id: input.expectedProviderSessionId,
        providerNativeSessionId: input.providerResumeHandle ?? '',
        discovered: input.discovery.state === 'discovered',
      });
    },

    async getProviderSession(_principal, providerSessionId) {
      const held = sessions.get(providerSessionId);
      if (!held) {
        return b3fail(b3err('ProviderSessionReservationConflict', 'no such session',
          { reservedProviderSessionId: providerSessionId }, false));
      }
      return b3ok({
        id: providerSessionId,
        providerNativeSessionId: held.native,
        discovered: held.discovered,
      });
    },

    async continuationAllowed(_principal, input) {
      const held = plans.get(input.launchPlanId);
      if (held && !held.lifecyclePolicy.allowedContinuationModes.includes(input.mode)) {
        return b3fail(b3err('LaunchPlanInvalid', `${input.mode} is not permitted`,
          { issues: [{ path: 'mode', message: 'not permitted' }] }, false));
      }
      return b3ok(null);
    },

    async getControlReplacementPlan(_principal, planId) {
      return b3fail(b3err('LaunchPlanInvalid', 'no replacement plans in this rig',
        { issues: [{ path: 'replacementPlanId', message: String(planId) }] }, false));
    },

    async discoverAgentControls(_principal, input) {
      return b3ok({
        agentRunId: input.agentRunId,
        provider: 'claude',
        testedProviderVersion: 'fake-1.0.0',
        controls: [
          {
            name: 'model', allowedValues: ['cli-default', 'other-model'],
            support: 'native', enforcement: 'enforced', reason: 'fake adapter',
          },
          {
            name: 'effort', support: 'replacement-required',
            enforcement: 'enforced', reason: 'fake adapter cannot change effort in place',
          },
        ],
      });
    },

    /**
     * Answers the way the real one does for the three cases that matter, so a
     * Runtime test proves something about all three rather than about `model`.
     */
    async applyAgentControl(_context, input) {
      controlsApplied.push(input.control);
      if (input.control.name === 'effort') {
        return b3ok({
          kind: 'replacement-required',
          replacementPlanId: mintObjectId('controlReplacement') as never,
          proposedLaunchPlanId: input.launchPlanId,
        });
      }
      if (input.control.name === 'provider-setting') {
        return b3ok({
          kind: 'unsupported', support: 'unsupported',
          reason: `the fake provider has no setting named ${input.control.value}`,
        });
      }
      return b3ok({
        kind: 'applied-native',
        agentRunId: input.agentRunId,
        control: input.control,
      });
    },
  };
  return port;
}

function refusal(
  port: FakeAgents, operation: string,
): B3Result<never> | null {
  if (port.refuseNext?.operation !== operation) return null;
  const error = port.refuseNext.error;
  port.refuseNext = null;
  return b3fail(error);
}
