// Role profiles: manager, builder, auditor as DATA (DEC-B3V4-03).
//
// A role is the reusable half of governance. The half that binds is the
// resolved plan in `plans.ts` — editing a role never reaches a live Run.
import {
  b3err, b3fail, b3ok, mintAgentRoleProfileId, nowIsoUtc, validationFailed,
  type AgentRoleProfileId, type AuthenticatedPrincipal, type B3Result,
  type CommandContext, type RecordVersion,
} from '@novakai/foundation/contract';
import type { CreateRoleProfileInput, UpdateRoleProfileInput } from '../contract/api.js';
import {
  readCreateRoleProfileInput, readUpdateRoleProfileInput,
} from '../contract/validate.js';
import type { AgentRoleProfile } from '../contract/records.js';
import type { GovernedAgentsCore } from './context.js';
import { roleNotAllowed, type Persisted } from './store.js';
import { compatibleRole } from './compat.js';

const WATCH_START_TURN_SCOPE = 'supervision:watch:start-turn';

function requiresWatcherStartTurn(
  core: GovernedAgentsCore, input: CreateRoleProfileInput,
): boolean {
  return input.supervisionPolicy.activityDrift === 'required'
    || input.supervisionPolicy.parentNotificationMode === 'start-turn'
    || input.supervisionPolicy.requiredWatcherTemplates.some(
      (templateRef) => core.watcherTemplates.inspect(templateRef)?.requiresStartTurn === true,
    );
}

function requireWatcherAuthority(
  core: GovernedAgentsCore,
  context: CommandContext,
  input: CreateRoleProfileInput,
): B3Result<null> {
  if (!requiresWatcherStartTurn(core, input)
    || context.principal.verifiedScopes.includes(WATCH_START_TURN_SCOPE as never)) {
    return b3ok(null);
  }
  return b3fail(b3err(
    'PermissionDenied',
    `role policy requires ${WATCH_START_TURN_SCOPE}`,
    { requiredScope: WATCH_START_TURN_SCOPE },
    false,
  ));
}

function requireResolvableTemplates(
  core: GovernedAgentsCore,
  input: CreateRoleProfileInput,
): B3Result<null> {
  const seen = new Set<string>();
  for (const templateRef of input.supervisionPolicy.requiredWatcherTemplates) {
    if (seen.has(templateRef.id) || templateRef.id === 'watch-template/activity-drift') {
      return b3fail(b3err(
        'WatchRuleInvalid', 'explicit watcher template ids must be unique and non-implicit',
        { templateId: templateRef.id }, false,
      ));
    }
    seen.add(templateRef.id);
    if (core.watcherTemplates.inspect(templateRef) === null) {
      return b3fail(b3err(
        'WatchRuleInvalid', 'role references an unresolved watcher template',
        { templateRef }, false,
      ));
    }
  }
  return b3ok(null);
}

export async function createRoleProfile(
  core: GovernedAgentsCore, context: CommandContext, input: CreateRoleProfileInput,
): Promise<B3Result<AgentRoleProfile>> {
  // Validated even though the caller is typed: an in-process caller and a
  // socket caller must travel the SAME policy path (red gate 23).
  const read = readCreateRoleProfileInput(input);
  if (!read.ok) return read;
  const authorized = requireWatcherAuthority(core, context, read.value);
  if (!authorized.ok) return authorized;
  const resolved = requireResolvableTemplates(core, read.value);
  if (!resolved.ok) return resolved;

  const record: Persisted<AgentRoleProfile> = {
    kind: 'agentRoleProfile',
    id: mintAgentRoleProfileId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    ...read.value,
  };
  return core.store.create<AgentRoleProfile>(
    context.principal.id, record as never, context.clientOpId,
  );
}

/**
 * A role update is a compare-and-set on the whole policy body. A stale writer
 * loses rather than silently reverting a colleague's edit, and the identity,
 * creation time and creator are never patched.
 */
export async function updateRoleProfile(
  core: GovernedAgentsCore, context: CommandContext, input: UpdateRoleProfileInput,
): Promise<B3Result<AgentRoleProfile>> {
  const read = readUpdateRoleProfileInput(input);
  if (!read.ok) return read;
  const authorized = requireWatcherAuthority(core, context, read.value.replacement);
  if (!authorized.ok) return authorized;
  const resolved = requireResolvableTemplates(core, read.value.replacement);
  if (!resolved.ok) return resolved;
  const existing = await core.store.read<AgentRoleProfile>(
    'agentRoleProfile', read.value.roleProfileId,
  );
  if (!existing.ok) return existing;
  if (existing.value === null) return b3fail(unknownRole(read.value.roleProfileId));
  return core.store.update<AgentRoleProfile>(
    context.principal.id, read.value.roleProfileId,
    read.value.replacement as unknown as Record<string, unknown>,
    read.value.expectedRecordVersion, context.clientOpId,
  );
}

export async function getRoleProfile(
  core: GovernedAgentsCore,
  _principal: AuthenticatedPrincipal,
  roleProfileId: AgentRoleProfileId,
): Promise<B3Result<AgentRoleProfile>> {
  const found = await core.store.read<AgentRoleProfile>('agentRoleProfile', roleProfileId);
  if (!found.ok) return found;
  if (found.value === null) return b3fail(unknownRole(roleProfileId));
  return b3ok(compatibleRole(found.value));
}

/**
 * §11's error vocabulary is closed, and there is no `UnknownRole` in it. A role
 * that does not exist and a role that is retired are the same answer to the
 * caller — you may not launch from this — so both are `RoleNotAllowed` and the
 * message says which.
 */
export const unknownRole = (roleProfileId: string): ReturnType<typeof roleNotAllowed> =>
  roleNotAllowed(roleProfileId, `no role profile "${roleProfileId}"`);

export const roleVersionOf = (role: AgentRoleProfile): RecordVersion => role.recordVersion;

export async function listRoleProfiles(
  core: GovernedAgentsCore, _principal: AuthenticatedPrincipal,
): Promise<B3Result<readonly AgentRoleProfile[]>> {
  const listed = await core.store.list<AgentRoleProfile>('agentRoleProfile');
  return listed.ok ? b3ok(listed.value.map(compatibleRole)) : listed;
}

/**
 * A5-04: a role BY NAME, resolved by the owner — exact, case-sensitive,
 * whole-string, over non-archived profiles. **The query never chooses.**
 *
 * It answers one question: which profile is named this. Zero and many are both
 * `ValidationFailed`, because both mean the caller's name did not identify a
 * profile; the many form hands back every candidate id, since naming it by id
 * is the operator's only way forward.
 *
 * `AgentRoleProfile.status` is `'active' | 'retired'` and has no `archived`
 * state, so "non-archived" excludes nothing here. That is also the only
 * reading that keeps this out of the launch policy's job: whether a retired
 * role may be LAUNCHED from is decided once, in `plans.ts` (`retiredRole`),
 * which refuses it BY NAME. A lookup that hid retired profiles would answer
 * "no role is named builder" when there is one — a false statement, and the
 * defect the client-side filter this replaces actually shipped.
 */
export async function resolveRoleProfileByName(
  core: GovernedAgentsCore, principal: AuthenticatedPrincipal, displayName: string,
): Promise<B3Result<AgentRoleProfile>> {
  const listed = await listRoleProfiles(core, principal);
  if (!listed.ok) return listed;
  const matched = listed.value.filter((role) => role.name === displayName);
  if (matched.length === 1) return b3ok(matched[0]!);
  if (matched.length === 0) {
    return b3fail(validationFailed([{
      path: 'displayName',
      message: `no role profile is named "${displayName}"`,
    }]));
  }
  return b3fail(validationFailed([
    { path: 'displayName', message: `${matched.length} role profiles are named "${displayName}"` },
    ...matched.map((role, index) => ({ path: `candidates[${index}]`, message: role.id })),
  ]));
}
