/**
 * Finding the provider's own transcript file for a binding — §8.2, §27.
 *
 * A `TranscriptBinding` names Novakai's `ProviderSessionId`. The file on disk is
 * named after the provider's OWN session id, which only Agents knows. So this
 * locator takes one question — "what native id did this Run turn out to have?"
 * — and turns it into a path, by looking where each provider actually writes:
 *
 *   claude  ~/.claude/projects/<project>/<native>.jsonl
 *   codex   ~/.codex/**\/<...native...>.jsonl
 *   kimi    ~/.kimi-code/**\/<...native...>.jsonl
 *
 * It only ever READS, and only ever below the provider's own home (§27:
 * "provider transcript originals remain untouched"). Nothing here writes,
 * moves, truncates or locks anything.
 *
 * The scan is bounded and cached: a Run's file is found once and remembered,
 * because the mirror asks on every pass and a provider home can hold thousands
 * of sessions.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { TranscriptBinding } from '../contract/records.js';

export type ProviderKind = 'claude' | 'codex' | 'kimi';

export interface ProviderHomes {
  readonly claude: string;
  readonly codex: string;
  readonly kimi: string;
}

export function defaultProviderHomes(home: string = homedir()): ProviderHomes {
  return {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex'),
    kimi: path.join(home, '.kimi-code'),
  };
}

export interface ProviderFileLocatorOptions {
  /**
   * The provider's own session id for this binding, asked of whoever owns that
   * fact. `null` means "not discovered yet", which is a `waiting` binding
   * rather than a missing one.
   */
  readonly nativeSessionIdOf: (
    binding: TranscriptBinding,
  ) => Promise<string | null>;
  readonly homes?: Partial<ProviderHomes>;
  /** How deep to walk a provider home. Deep enough for every known layout. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 5;

/**
 * A file whose NAME carries the session id. Every provider names its transcript
 * after the session, which is why an id match on the basename is a real match
 * rather than a guess — and why an id that appears only in file CONTENT is
 * deliberately not accepted: two sessions can mention each other.
 */
function findByName(
  folder: string, needle: string, depth: number, maxDepth: number,
): string | null {
  if (depth > maxDepth || !existsSync(folder)) return null;
  const scanned = scanFolder(folder, needle);
  if (scanned.match !== null) return scanned.match;
  for (const child of scanned.folders) {
    const found = findByName(child, needle, depth + 1, maxDepth);
    if (found !== null) return found;
  }
  return null;
}

/**
 * One directory level: the matching transcript if it is here, and the
 * sub-folders still to look in. Split out because the walk and the match are
 * two different questions, and an entry that vanishes mid-scan is an answer to
 * neither.
 */
function scanFolder(
  folder: string, needle: string,
): { readonly match: string | null; readonly folders: readonly string[] } {
  let entries: readonly string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return { match: null, folders: [] };
  }
  const folders: string[] = [];
  for (const entry of entries) {
    const full = path.join(folder, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // a file that vanished mid-scan is not an error
    }
    if (stat.isDirectory()) folders.push(full);
    else if (entry.endsWith('.jsonl') && entry.includes(needle)) {
      return { match: full, folders };
    }
  }
  return { match: null, folders };
}

export function createProviderFileLocator(
  options: ProviderFileLocatorOptions,
): (binding: TranscriptBinding) => Promise<string | null> {
  const homes = { ...defaultProviderHomes(), ...options.homes };
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const resolved = new Map<string, string>();

  return async (binding: TranscriptBinding): Promise<string | null> => {
    const cached = resolved.get(binding.id);
    // Re-check existence: a cached path whose file was rotated away must go
    // back to `missing` rather than keep being reported as the source.
    if (cached !== undefined && existsSync(cached)) return cached;

    const native = await options.nativeSessionIdOf(binding);
    if (native === null || native.trim() === '') return null;

    const home = homes[binding.provider as ProviderKind];
    if (home === undefined) return null;
    const found = findByName(home, native, 0, maxDepth);
    if (found !== null) resolved.set(binding.id, found);
    return found;
  };
}
