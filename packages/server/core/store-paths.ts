/** The one spelling of a root's canonical Foundation store directory. */
import path from 'node:path';

/**
 * The canonical JSONL directory for a root. Spelled once: a composition
 * that computes it differently opens a second route under the same root.
 */
export function canonicalDataRoot(root: string): string {
  return path.join(root, 'stores');
}
