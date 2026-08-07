// packages/server/core/supervision/log.ts — `.novakai/supervision/usage.jsonl`.
//
// Ownership map (§11): the server's supervision engine is this file's SOLE
// writer. §13 disposition 1 exists because the standalone
// scripts/agent-watchdog.mjs used to be a second writer to `.novakai/`; it is
// now read-only, and this module is the one place a usage line is appended.
//
// Append-only, one JSON line per emission, directory created on demand. A write
// failure is reported to the caller rather than thrown: a full disk must not
// take the server down mid-supervision, but it must not pass unnoticed either.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface UsageLog {
  readonly filePath: string;
  /** Returns null on success, or the reason it could not be written. */
  append(entry: { at: string; rows: unknown[] }): string | null;
}

export function createUsageLog(root: string): UsageLog {
  const dir = path.join(root, 'supervision');
  const filePath = path.join(dir, 'usage.jsonl');
  return {
    filePath,
    append(entry) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}
