// Creating the individual (DEC-B3V4-02).
//
// An Agent outlives every Run it ever has. It is created once, from a role,
// with its root human and its parent fixed at birth — all three derived from
// what the transport authenticated, never from the request body (red gate 5).
import {
  b3fail, b3ok, mintObjectId, nowIsoUtc,
  type AgentId, type AuthenticatedPrincipal, type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import type { CreateAgentFromRoleInput } from '../contract/api.js';
import { readCreateAgentFromRoleInput } from '../contract/validate.js';
import type { Agent, AgentRelationship, AgentRoleProfile } from '../contract/records.js';
import type { GovernedAgentsCore } from './context.js';
import { unknownAgent, type Persisted } from './store.js';
import { getRoleProfile } from './roles.js';
import { recordRelationship } from './relationships.js';

/**
 * The pre-B3 fields the existing Agents registry still reads off kind `agent`.
 *
 * Build 3 did not fork the agent store — one kind, one writer, two readers
 * (red gate 25). So a governed Agent persists its role-derived provider and
 * model alongside the B3 fields, and `packages/agents/core/registry` keeps
 * working unchanged. These are a PROJECTION of the role; the authority for what
 * a Run actually launches with is its pinned `ResolvedLaunchPlan`.
 */
interface LegacyAgentCompatibility {
  readonly provider: string;
  readonly model: string;
  readonly instructions: string;
  readonly hooks: readonly never[];
  readonly skills: readonly string[];
}

export async function createAgentFromRole(
  core: GovernedAgentsCore, context: CommandContext, input: CreateAgentFromRoleInput,
): Promise<B3Result<{ readonly agent: Agent; readonly relationship?: AgentRelationship }>> {
  const read = readCreateAgentFromRoleInput(input);
  if (!read.ok) return read;
  const request = read.value;

  const role = await getRoleProfile(core, context.principal, request.roleProfileId);
  if (!role.ok) return role;
  if (role.value.status === 'retired') {
    return b3fail({
      code: 'RoleNotAllowed',
      message: `role "${role.value.name}" is retired and cannot create new Agents`,
      details: { roleProfileId: role.value.id },
      retryable: false,
    });
  }

  const record: Persisted<Agent> & LegacyAgentCompatibility = {
    kind: 'agent',
    id: mintObjectId('agent') as unknown as AgentId,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    displayName: request.displayName,
    roleProfileId: role.value.id,
    rootHumanPrincipalId: request.rootHumanPrincipalId,
    status: 'active',
    ...legacyCompatibility(role.value),
  };
  const created = await core.store.create<Agent>(
    context.principal.id, record as never, context.clientOpId,
  );
  if (!created.ok) return created;

  if (request.parentAgentId === undefined || request.creatingRunId === undefined) {
    return b3ok({ agent: created.value });
  }
  const edge = await recordRelationship(core, context, {
    rootHumanPrincipalId: request.rootHumanPrincipalId,
    parentAgentId: request.parentAgentId,
    childAgentId: created.value.id,
    createdFromRunId: request.creatingRunId,
  });
  if (!edge.ok) return edge;
  return b3ok({ agent: created.value, relationship: edge.value });
}

function legacyCompatibility(role: AgentRoleProfile): LegacyAgentCompatibility {
  return {
    provider: role.providerPolicy.defaultProvider,
    model: role.modelPolicy.defaultModelId,
    instructions: role.description,
    hooks: [],
    skills: role.skillRefs.map((skill) => skill.id),
  };
}

export async function requireAgent(
  core: GovernedAgentsCore, agentId: AgentId,
): Promise<B3Result<Agent>> {
  const found = await core.store.read<Agent>('agent', agentId);
  if (!found.ok) return found;
  if (found.value === null) return b3fail(unknownAgent(agentId));
  // A record written by the pre-B3 registry has no role and no root human, so
  // it is not a governed Agent and cannot be launched as one. Saying so beats
  // resolving a plan against `undefined`.
  if (found.value.roleProfileId === undefined) {
    return b3fail({
      code: 'UnknownAgent',
      message: `agent "${agentId}" predates governed roles and has no role profile`,
      details: { agentId },
      retryable: false,
    });
  }
  if (found.value.status === 'archived') {
    return b3fail({
      code: 'AgentArchived', message: `agent "${agentId}" is archived`,
      details: { agentId }, retryable: false,
    });
  }
  return b3ok(found.value);
}

export async function getAgent(
  core: GovernedAgentsCore, _principal: AuthenticatedPrincipal, agentId: AgentId,
): Promise<B3Result<Agent>> {
  return requireAgent(core, agentId);
}
