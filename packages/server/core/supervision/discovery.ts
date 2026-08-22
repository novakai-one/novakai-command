// packages/server/core/supervision/discovery.ts — transcript discovery
// (split from usage.ts, SUPFIX step 0). One walk per interval; no session is
// allowed to launch its own directory scan.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  providerTranscriptRoots,
  sanitizeProviderCwd,
} from '../../../agents/contract/index.js';

/** claude sanitizes a cwd into its projects dir name: /a/b → -a-b. */
export function sanitizeCwd(cwd: string): string {
  return sanitizeProviderCwd(cwd);
}

/** Depth-limited async file listing. Never throws on an unreadable dir. */
async function walk(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, depth - 1));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * One discovery pass across every provider root. Usage intervals share this
 * manifest; no session is allowed to launch its own directory walk.
 */
export async function discoverTranscripts(home: string, transcriptRoot?: string): Promise<string[]> {
  const roots = providerTranscriptRoots(home, transcriptRoot);
  return (await Promise.all(roots.map(({ root, depth }) => walk(root, depth)))).flat();
}
