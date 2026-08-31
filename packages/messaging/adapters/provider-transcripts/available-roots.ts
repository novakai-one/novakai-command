import { realpath } from 'node:fs/promises';
import { isErrno } from '../../core/thrown.js';

/** One root's canonical path, or nothing when it does not exist yet. */
const resolveRoot = async (candidate: string): Promise<string | undefined> => {
  try {
    return await realpath(candidate);
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return undefined;
    throw cause;
  }
};

/**
 * Resolves configured roots to canonical paths, skipping the ones that do not
 * exist yet. Missing roots are dormant, not erroneous — discovery may find
 * them on a later pass. Any other filesystem failure propagates.
 */
export async function existingRoots(configured: readonly string[]): Promise<readonly string[]> {
  const resolved = await Promise.all(configured.map(resolveRoot));
  return resolved.filter((root): root is string => root !== undefined);
}
