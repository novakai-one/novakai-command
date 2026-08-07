// Server-enforced delegation (DEC-B3V4-12, red gate 6).
//
// One sentence decides everything here: a grant is the INTERSECTION of root
// policy, role policy and what the issuer actually holds. Intersection has the
// property the red gate needs — it can only ever shrink. There is no code path
// in this file that can add a scope to a grant, which is why "a child receives
// authority its parent could not delegate" is not merely tested against but
// unrepresentable.
import {
  b3err, b3fail, b3ok, deriveClientOpId, mintDelegationGrantId, nowIsoUtc,
  type AgentId, type AuthenticatedPrincipal, type AuthorityScope, type B3Result,
  type CommandContext, type DelegationGrantId, type AgentRoleProfileId,
} from '@novakai/foundation/contract';
import type {
  AuthoriseSpawnInput, IssueDelegationGrantInput, SpawnAuthority,
} from '../contract/api.js';
import {
  readAuthoriseSpawnInput, readIssueDelegationGrantInput,
} from '../contract/validate.js';
import type { Agent, AgentRoleProfile, DelegationGrant } from '../contract/records.js';
import {
  authorityEscalation, permissionDenied, RUN_OPERATION_SCOPE, SCOPE,
  type GovernedAgentsCore,
} from './context.js';
import { roleNotAllowed, type Persisted } from './store.js';
import { requireAgent } from './agents.js';
import { getRoleProfile } from './roles.js';
import { ancestorIdsOf, descendantIdsOf } from './relationships.js';

/**
 * What an issuing Run may hand on. A human-rooted Run holds the full human set;
 * an Agent-rooted Run holds whatever ITS grant carries, and never more.
 */
async function issuerScopes(
  core: GovernedAgentsCore, principal: AuthenticatedPrincipal,
): Promise<B3Result<readonly AuthorityScope[]>> {
  if (principal.kind !== 'agent-run') return b3ok(principal.verifiedScopes);
  const grants = await liveGrantsFor(core, principal);
  if (!grants.ok) return grants;
  const held = new Set<AuthorityScope>();
  for (const grant of grants.value) for (const scope of grant.scopes) held.add(scope);
  return b3ok([...held]);
}

/**
 * Every active grant this authenticated Run holds.
 *
 * `issuerAgentRunId` names the Run whose authority the grant derives from and
 * dies with — which is the holder's own Run, because the Runtime issues a Run's
 * grants against that Run when it starts and whenever it gains a child. That is
 * what makes `expiresWhenIssuerRunFinal` mean something: an Agent cannot
 * outlive the authority it was given.
 */
async function liveGrantsFor(
  core: GovernedAgentsCore, principal: AuthenticatedPrincipal,
): Promise<B3Result<readonly DelegationGrant[]>> {
  const listed = await core.store.list<DelegationGrant>('delegationGrant', { status: 'active' });
  if (!listed.ok) return listed;
  const holder = principal.agentRunId;
  if (holder === undefined) return b3ok([]);
  return b3ok(listed.value.filter((grant) => grant.issuerAgentRunId === holder));
}

export async function issueDelegationGrant(
  core: GovernedAgentsCore, context: CommandContext, input: IssueDelegationGrantInput,
): Promise<B3Result<DelegationGrant>> {
  const read = readIssueDelegationGrantInput(input);
  if (!read.ok) return read;
  const request = read.value;

  const issuable = await issuerScopes(core, context.principal);
  if (!issuable.ok) return issuable;

  const subject = await requireAgent(core, request.subjectAgentId);
  if (!subject.ok) return subject;
  const role = await getRoleProfile(core, context.principal, subject.value.roleProfileId);
  if (!role.ok) return role;

  const scopes = request.requestedScopes.filter((scope) => issuable.value.includes(scope));
  if (scopes.length !== request.requestedScopes.length) {
    return b3fail(authorityEscalation(request.requestedScopes, issuable.value));
  }

  // Scope names were the only thing ever intersected, so a grant carrying
  // scopes its issuer held could still POINT at an Agent the issuer cannot
  // reach — authority widening by target rather than by name
  // (NVK-KIMI-028 finding 3, §22, red gate 6).
  const reachable = await callerReach(core, context.principal);
  if (!reachable.ok) return reachable;
  if (reachable.value !== null) {
    const beyond = request.targetAgentIds.filter((id) => !reachable.value!.has(id));
    if (beyond.length > 0) {
      return b3fail(authorityEscalation(request.requestedScopes, issuable.value, beyond));
    }
  }

  const childRoles = intersectRoles(request.requestedChildRoleIds, role.value);
  if (childRoles.length !== request.requestedChildRoleIds.length) {
    return b3fail(roleNotAllowed(
      request.requestedChildRoleIds.find((id) => !childRoles.includes(id)) ?? '',
      `role "${role.value.name}" may not spawn that child role`,
      request.subjectAgentId,
    ));
  }

  const record: Persisted<DelegationGrant> = {
    kind: 'delegationGrant',
    id: mintDelegationGrantId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    issuerAgentRunId: request.issuerAgentRunId,
    subjectAgentId: request.subjectAgentId,
    targetAgentIds: request.targetAgentIds,
    scopes,
    allowedChildRoleIds: childRoles,
    expiresWhenIssuerRunFinal: true,
    status: 'active',
  };
  return core.store.create<DelegationGrant>(
    context.principal.id, record as never, context.clientOpId,
  );
}

/**
 * Every Agent this caller may already act upon — or `null` for a human, who
 * roots every family on the machine and is bounded by scopes alone.
 *
 * An Agent's own identity is read from the self-grant the Runtime issues it at
 * spawn (issuer = its Run, no targets); from there its reach is its own
 * subtree plus whatever its other grants name, and their subtrees.
 */
async function callerReach(
  core: GovernedAgentsCore, principal: AuthenticatedPrincipal,
): Promise<B3Result<Set<AgentId> | null>> {
  if (principal.kind !== 'agent-run') return b3ok(null);
  const grants = await liveGrantsFor(core, principal);
  if (!grants.ok) return grants;
  const roots = new Set<AgentId>();
  for (const held of grants.value) {
    roots.add(held.subjectAgentId);
    for (const target of held.targetAgentIds) roots.add(target);
  }
  const reach = new Set<AgentId>(roots);
  for (const root of roots) {
    const descendants = await descendantIdsOf(core, root);
    if (!descendants.ok) return descendants;
    for (const id of descendants.value) reach.add(id);
  }
  return b3ok(reach);
}

/** The role's own spawn policy is the ceiling; the request can only narrow it. */
function intersectRoles(
  requested: readonly AgentRoleProfileId[], role: AgentRoleProfile,
): readonly AgentRoleProfileId[] {
  return requested.filter((id) => role.spawnPolicy.allowedChildRoleIds.includes(id));
}

/**
 * Whose tree this lands in, who the parent is, and which grant permitted it.
 * All three derived here — a caller that could name its own parent could
 * attach itself anywhere in the org chart (red gate 5).
 */
export async function authoriseSpawn(
  core: GovernedAgentsCore, principal: AuthenticatedPrincipal, input: AuthoriseSpawnInput,
): Promise<B3Result<SpawnAuthority>> {
  const read = readAuthoriseSpawnInput(input);
  if (!read.ok) return read;
  const request = read.value;

  if (principal.kind === 'agent-run') return authoriseAgentSpawn(core, principal, request);
  if (principal.kind === 'system') {
    return b3fail(permissionDenied('agent.spawn', SCOPE.spawn));
  }
  // Human, script and Operations callers spawn ROOT Agents in the local
  // human's tree. They still need the scope; a principal without it is refused.
  if (!principal.verifiedScopes.includes(SCOPE.spawn)) {
    return b3fail(permissionDenied('agent.spawn', SCOPE.spawn));
  }
  return b3ok({
    rootHumanPrincipalId: core.rootHumanPrincipalId,
    launchSurface: principal.kind === 'script' ? 'script'
      : principal.kind === 'operations' ? 'operations' : 'novakai-shell',
  });
}

async function authoriseAgentSpawn(
  core: GovernedAgentsCore, principal: AuthenticatedPrincipal, request: AuthoriseSpawnInput,
): Promise<B3Result<SpawnAuthority>> {
  if (request.callerAgentId === undefined) {
    return b3fail(permissionDenied('agent.spawn', SCOPE.spawn));
  }
  const parent = await requireAgent(core, request.callerAgentId);
  if (!parent.ok) return parent;

  const grants = await liveGrantsFor(core, principal);
  if (!grants.ok) return grants;
  const permitting = grants.value.find((grant) => grant.scopes.includes(SCOPE.spawn)
    && grant.allowedChildRoleIds.includes(request.roleProfileId));
  if (!permitting) {
    // Distinguishing these two matters to whoever reads the error: "you cannot
    // spawn at all" and "you cannot spawn THAT role" are different problems.
    const canSpawn = grants.value.some((grant) => grant.scopes.includes(SCOPE.spawn));
    return b3fail(canSpawn
      ? roleNotAllowed(request.roleProfileId,
        'no active grant permits this caller to spawn that role', request.callerAgentId)
      : permissionDenied('agent.spawn', SCOPE.spawn));
  }

  const depth = await depthOf(core, parent.value);
  if (!depth.ok) return depth;
  const role = await getRoleProfile(core, principal, parent.value.roleProfileId);
  if (!role.ok) return role;
  const maxDepth = role.value.spawnPolicy.maxDepth;
  if (maxDepth !== undefined && depth.value + 1 > maxDepth) {
    return b3fail(roleNotAllowed(request.roleProfileId,
      `role "${role.value.name}" allows at most ${maxDepth} generations below the root`,
      request.callerAgentId));
  }

  return b3ok({
    rootHumanPrincipalId: parent.value.rootHumanPrincipalId,
    parentAgentId: parent.value.id,
    grantId: permitting.id,
    launchSurface: 'agent',
  });
}

async function depthOf(
  core: GovernedAgentsCore, agent: Agent,
): Promise<B3Result<number>> {
  const ancestors = await ancestorIdsOf(core, agent.id);
  if (!ancestors.ok) return ancestors;
  return b3ok(ancestors.value.length);
}

/**
 * The same intersection rule for everything a caller can do TO another Agent,
 * so a human, a script and an Agent are judged by one code path (red gate 23).
 */
export async function authoriseRunOperation(
  core: GovernedAgentsCore,
  principal: AuthenticatedPrincipal,
  input: {
    readonly targetAgentId: AgentId;
    readonly operation: 'interrupt' | 'stop-one' | 'stop-tree' | 'adopt' | 'continue' | 'control';
  },
): Promise<B3Result<{ readonly grantId?: DelegationGrantId }>> {
  const required = RUN_OPERATION_SCOPE[input.operation]!;
  const denied = b3fail(permissionDenied(`agent.${input.operation}`, required));
  if (principal.kind !== 'agent-run') {
    return principal.verifiedScopes.includes(required) ? b3ok({}) : denied;
  }
  const grants = await liveGrantsFor(core, principal);
  if (!grants.ok) return grants;
  const permitting = await firstGrantReaching(
    core, grants.value, required, input.targetAgentId,
  );
  if (!permitting.ok) return permitting;
  return permitting.value === null ? denied : b3ok({ grantId: permitting.value.id });
}

/**
 * A grant reaches a named target OR any descendant of one, so a parent that may
 * stop its child may also stop that child's own subtree — and no further.
 */
async function firstGrantReaching(
  core: GovernedAgentsCore,
  grants: readonly DelegationGrant[],
  required: AuthorityScope,
  targetAgentId: AgentId,
): Promise<B3Result<DelegationGrant | null>> {
  for (const grant of grants) {
    if (!grant.scopes.includes(required)) continue;
    const reaches = await grantReaches(core, grant, targetAgentId);
    if (!reaches.ok) return reaches;
    if (reaches.value) return b3ok(grant);
  }
  return b3ok(null);
}

async function grantReaches(
  core: GovernedAgentsCore, grant: DelegationGrant, targetAgentId: AgentId,
): Promise<B3Result<boolean>> {
  if (grant.targetAgentIds.includes(targetAgentId)) return b3ok(true);
  for (const target of grant.targetAgentIds) {
    const descendants = await descendantIdsOf(core, target);
    if (!descendants.ok) return descendants;
    if (descendants.value.includes(targetAgentId)) return b3ok(true);
  }
  return b3ok(false);
}

/**
 * `expiresWhenIssuerRunFinal` made real: when a Run ends, everything it handed
 * out ends with it. Otherwise an Agent could outlive its own authority.
 *
 * Each grant is expired under its OWN derived key (§3.2). One command's
 * `clientOpId` across N writes is N-1 replays: Foundation deduplicates by
 * clientOpId, so the second and later grants came back as the record that was
 * already there — `status: 'active'` — while this function reported all of them
 * expired and every caller discarded the result (NVK-KIMI-031 finding 2).
 *
 * The returned list is what the STORE now says, not what was attempted.
 */
export async function expireGrantsOfRun(
  core: GovernedAgentsCore, context: CommandContext, agentRunId: string,
): Promise<B3Result<{ readonly expired: readonly DelegationGrantId[] }>> {
  const listed = await core.store.list<DelegationGrant>('delegationGrant', { status: 'active' });
  if (!listed.ok) return listed;
  const expired: DelegationGrantId[] = [];
  for (const grant of listed.value) {
    if (grant.issuerAgentRunId !== agentRunId) continue;
    const updated = await core.store.update<DelegationGrant>(
      context.principal.id, grant.id, { status: 'expired' },
      grant.recordVersion,
      deriveClientOpId(`${String(context.clientOpId)}:expire-grant:${String(grant.id)}`),
    );
    if (!updated.ok) return updated;
    if (updated.value.status !== 'expired') {
      return b3fail(b3err('RecoveryRequired',
        'a grant could not be expired with its issuing Run',
        { grantId: grant.id, agentRunId, status: updated.value.status }, true));
    }
    expired.push(grant.id);
  }
  return b3ok({ expired });
}

/**
 * The grants a caller may SEE (§12.1, hold-out D10).
 *
 * Grants were being written all along — a blind consumer watched
 * `delegationGrants.jsonl` grow — but nothing read them back, so every §22 row
 * that turns on a grant was untestable from outside. A human sees the machine's
 * grants; an Agent Run sees only the ones it holds, because a grant it cannot
 * use is not its business.
 */
export async function listDelegationGrants(
  core: GovernedAgentsCore,
  principal: AuthenticatedPrincipal,
  filter: { readonly holderAgentRunId?: string } = {},
): Promise<B3Result<readonly DelegationGrant[]>> {
  const listed = await core.store.list<DelegationGrant>('delegationGrant', { status: 'active' });
  if (!listed.ok) return listed;
  const visible = principal.kind === 'agent-run'
    ? listed.value.filter((grant) => grant.issuerAgentRunId === principal.agentRunId)
    : listed.value;
  const holder = filter.holderAgentRunId;
  if (holder === undefined) return b3ok(visible);
  return b3ok(visible.filter((grant) => grant.issuerAgentRunId === holder));
}
