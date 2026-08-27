// Roles, as an operator names them.
//
// Chris types names; ids are for machines. And a clean data root has no roles
// at all, so the CLI has to be able to make one — `b3.agent.createRole` was on
// the wire from the start, used by tests and the bundled proof, and reachable
// from no operator surface (probe M-2).
import { readFileSync } from 'node:fs';
import { b3err, b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';

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
