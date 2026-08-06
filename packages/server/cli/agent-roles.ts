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

/**
 * A role by NAME, because that is what Chris types — resolved by the OWNER.
 *
 * A5-04: the CLI asks one question and forwards one answer. It used to fetch
 * every role profile and run its own `name === given && status === 'active'`
 * filter, which made the CLI the author of a matching rule the Shell and any
 * script would each have spelled differently — and got it wrong twice over: a
 * retired role was invisible (so the refusal said "no active role is named
 * builder" when there was one), and two profiles sharing a name resolved
 * silently to whichever was live. The launch policy already refuses a retired
 * role by name; deciding that here was the CLI answering a question that is
 * not its to answer (OQ-02's shape).
 *
 * An `agentRole_` argument is an id, not a name: §4.1's prefix says so, and a
 * lookup would be asking the owner to confirm what the caller already told us.
 */
export async function roleIdFor(
  client: RuntimeClient, given: string,
): Promise<B3Result<string>> {
  if (given.startsWith('agentRole_')) return b3ok(given);
  const resolved = await client.call<AgentRoleProfile>(
    'b3.agent.resolveRoleByName', { displayName: given },
  );
  return resolved.ok ? b3ok(resolved.value.id) : resolved;
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
