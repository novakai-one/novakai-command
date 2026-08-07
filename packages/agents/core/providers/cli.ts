// core/providers/cli.ts — the two things every print-mode CLI adapter needs,
// in one place, so kimi/codex/claude do not each grow their own copy.
//
// This file is provider-NEUTRAL on purpose: it knows about "an executable on
// disk" and "a stream of JSON lines". Every provider-specific fact (argv,
// event shapes, resume flags) stays in that provider's own adapter, which is
// what red gate 2 actually protects.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Resolve a CLI to an absolute path. `explicit` (config `providers.<p>.cliPath`)
 * always wins. Otherwise the binary is looked up on PATH exactly the way the
 * shell would — codex and claude install as npm-global bins, so they have no
 * fixed home-relative location the way the kimi CLI does.
 *
 * Returns the bare name when nothing is found: `isAvailable()` then reports
 * false and `create()` refuses typed, rather than the adapter inventing a path.
 */
export function resolveCliPath(binaryName: string, explicit?: string): string {
  if (explicit) return explicit;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binaryName);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch { /* unreadable PATH entry — keep looking */ }
  }
  return binaryName;
}

/** True when the resolved path is a real file we could execute. */
export function cliExists(cliPath: string): boolean {
  try { return existsSync(cliPath) && statSync(cliPath).isFile(); } catch { return false; }
}

/**
 * Feed `onLine` every complete line of a child's stdout, then the trailing
 * partial line at close. Providers stream JSONL; a chunk boundary must never
 * swallow an event (the failure mode: the last reply of a fast turn is lost
 * because it arrived in the same chunk as EOF).
 */
export function lineReader(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  let buf = '';
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    },
    flush() {
      const tail = buf.trim();
      buf = '';
      if (tail) onLine(tail);
    },
  };
}

/** Attach a line reader to a child stream. Returns the reader's flush. */
export function readLines(stream: Readable | null, onLine: (line: string) => void): () => void {
  const reader = lineReader(onLine);
  stream?.on('data', (chunk: Buffer) => reader.push(chunk));
  return () => reader.flush();
}

/** Parse one JSONL line; a corrupt line is skipped, never thrown. */
export function parseJsonLine<T = Record<string, unknown>>(line: string): T | null {
  try { return JSON.parse(line) as T; } catch { return null; }
}
