// Role profiles: manager, builder, auditor as DATA (DEC-B3V4-03).
//
// A role is the reusable half of governance. The half that binds is the
// resolved plan in `plans.ts` — editing a role never reaches a live Run.
import {
  b3fail, b3ok, mintAgentRoleProfileId, nowIsoUtc,
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

export async function createRoleProfile(
  core: GovernedAgentsCore, context: CommandContext, input: CreateRoleProfileInput,
): Promise<B3Result<AgentRoleProfile>> {
  // Validated even though the caller is typed: an in-process caller and a
  // socket caller must travel the SAME policy path (red gate 23).
  const read = readCreateRoleProfileInput(input);
  if (!read.ok) return read;

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
  return b3ok(found.value);
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
