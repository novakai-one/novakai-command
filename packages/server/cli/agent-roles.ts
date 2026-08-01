// Roles, as an operator names them.
//
// Chris types names; ids are for machines. And a clean data root has no roles
// at all, so the CLI has to be able to make one — `b3.agent.createRole` was on
// the wire from the start, used by tests and the bundled proof, and reachable
// from no operator surface (probe M-2).
import { readFileSync } from 'node:fs';
import {
  b3err, b3fail, b3ok, type B3Result,
} from '@novakai/foundation/contract';
import type { AgentRoleProfile } from '../../agents/b3/contract/index.js';
import type { RuntimeClient } from '../core/b3/client.js';

/** A role by NAME, because that is what Chris types. */
export async function roleIdFor(
  client: RuntimeClient, given: string,
): Promise<B3Result<string>> {
  if (given.startsWith('agentRole_')) return b3ok(given);
  const roles = await client.call<readonly AgentRoleProfile[]>('b3.agent.getRoles', {});
  if (!roles.ok) return roles;
  const matched = roles.value.filter((role) => role.name === given && role.status === 'active');
  if (matched.length === 0) {
    return b3fail(b3err('RoleNotAllowed',
      `no active role is named "${given}"; try \`nvk agent roles\``,
      { roleProfileId: given }, false));
  }
  if (matched.length > 1) {
    return b3fail(b3err('RoleNotAllowed',
      `${matched.length} active roles are named "${given}"; name it by id`,
      { roleProfileId: given }, false));
  }
  return b3ok(matched[0]!.id);
}

/**
 * The role profile in a file, as data. It is NOT validated here — the wire
 * validator is the one that decides, and a second opinion at the CLI is a
 * second policy path (§3.2's "validate its complete boundary payload").
 */
export function roleFromFile(file: string): B3Result<unknown> {
  try {
    return b3ok(JSON.parse(readFileSync(file, 'utf8')));
  } catch (cause) {
    return b3fail(b3err('ValidationFailed',
      `could not read a role profile from ${file}`,
      {
        issues: [{
          path: 'file',
          message: cause instanceof Error ? cause.message : String(cause),
        }],
      }, false));
  }
}
