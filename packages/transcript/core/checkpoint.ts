// core/checkpoint — byte-offset checkpoints (R3-14, DEC-S2-10).
// The ONLY mutable watcher record; lives in .novakai/transcripts/.state/.
// Corrupt state = zero offsets = full re-copy (never data loss — §13.4).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface FileCheckpoint {
  /** Bytes copied so far (append cursor into the immutable copy). */
  offset: number;
  /** `dev:ino` — rotation/replacement detection. */
  inode: string;
  /** How many rescan copies have been written for this source. */
  rescans: number;
  /**
   * sha256 of the last ≤64 copied bytes. Size alone cannot detect
   * truncate-then-regrow-past-the-cursor (same inode, larger size); a tail
   * mismatch means the bytes we already copied no longer exist → rescan.
   */
  tail: string;
}

export type CheckpointTable = Record<string, FileCheckpoint>; // key: absolute source path

export function loadCheckpoints(stateDir: string): CheckpointTable {
  const file = path.join(stateDir, 'checkpoints.json');
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CheckpointTable;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {}; // corrupt → zero offsets → full re-copy, flagged by rescan copies (§13.4)
  }
}

/** Atomic write: tmp + rename, never a torn checkpoint file. */
export function saveCheckpoints(stateDir: string, table: CheckpointTable): void {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'checkpoints.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`);
  renameSync(tmp, file);
}
