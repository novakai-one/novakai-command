// What the three adapters share: finding the CLI, asking it its version, and
// recognising the session file it just created.
//
// Everything here produces EVIDENCE. A capability report that says `native`
// without naming what proved it is exactly the "presented as proven" red gate
// (27), so nothing in this file returns a bare boolean.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Resolve a CLI on PATH the way a login shell would. Empty when absent. */
export function resolveCli(name: string, fallback?: string): string {
  try {
    const found = execFileSync('/usr/bin/env', ['which', name], {
      encoding: 'utf8', timeout: 3_000,
    }).trim();
    if (found !== '') return found;
  } catch {
    // `which` exits non-zero when the CLI is not installed. That is the answer,
    // not a failure: an absent provider is reported as `unavailable`.
  }
  return fallback !== undefined && existsSync(fallback) ? fallback : '';
}

/**
 * The version string the capability report is stamped with. A report that
 * cannot name the version it was tested against is not evidence, so an
 * unprobeable CLI says so in the string rather than pretending.
 */
export function probeVersion(executable: string, argument = '--version'): string {
  if (executable === '') return 'not-installed';
  try {
    const output = execFileSync(executable, [argument], {
      encoding: 'utf8', timeout: 5_000,
    }).trim();
    return output.split(/\r?\n/)[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface SessionFileMatch {
  readonly nativeSessionId: string;
  readonly sourceLocator: string;
}

/**
 * Find the newest file below `root` that appeared after `since` and whose name
 * yields a native session id.
 *
 * This is the honest mechanism for a CLI that will not let Novakai pre-assign
 * an id: the Runtime knows exactly when it launched, so a session file created
 * after that moment, in that provider's own directory, is real evidence. It is
 * still evidence rather than proof, which is why a caller that gets `null` from
 * here reports `live: 'unknown'` instead of guessing.
 */
export function newestSessionSince(
  root: string, since: number, extract: (name: string) => string | null,
): SessionFileMatch | null {
  if (!existsSync(root)) return null;
  let best: { seenAt: number; match: SessionFileMatch } | null = null;
  for (const file of walk(root, 0)) {
    const nativeSessionId = extract(path.basename(file));
    if (nativeSessionId === null) continue;
    const seenAt = birthOf(file);
    if (seenAt < since) continue;
    if (best === null || seenAt > best.seenAt) {
      best = { seenAt, match: { nativeSessionId, sourceLocator: file } };
    }
  }
  return best?.match ?? null;
}

/** Bounded walk: provider session trees are date- or workspace-nested, not deep. */
function* walk(directory: string, depth: number): Generator<string> {
  if (depth > 5) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // An unreadable provider directory is an absent answer, not a crash: the
    // caller degrades to `live: 'unknown'`.
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield full;
      yield* walk(full, depth + 1);
      continue;
    }
    yield full;
  }
}

function birthOf(file: string): number {
  try {
    const stats = statSync(file);
    return Math.max(stats.birthtimeMs, stats.mtimeMs);
  } catch {
    return 0;
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** `rollout-<iso>-<uuid>.jsonl` — codex's own rollout naming. */
export function codexSessionIdFrom(name: string): string | null {
  const matched = new RegExp(`^rollout-.*-(${UUID})\\.jsonl$`).exec(name);
  return matched?.[1] ?? null;
}

/** `session_<uuid>` — kimi's per-workspace session directory. */
export function kimiSessionIdFrom(name: string): string | null {
  const matched = new RegExp(`^session_(${UUID})$`).exec(name);
  return matched?.[1] ?? null;
}

/**
 * The environment a spawned Agent needs to authenticate as itself when it uses
 * a B3 client from its managed PTY. Assembled by the Runtime and merged
 * verbatim; an adapter never invents or reads it.
 */
export function mergedEnvironment(
  base: NodeJS.ProcessEnv, runtime: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (typeof value === 'string') merged[name] = value;
  }
  for (const [name, value] of Object.entries(runtime)) merged[name] = value;
  return merged;
}

/** The uuid inside a `sess_<uuidv4>` Novakai id, for a CLI that accepts one. */
export function uuidOf(providerSessionId: string): string {
  return providerSessionId.replace(/^sess_/, '');
}
