// The real OS single-instance lease.
//
// `open(..., 'wx')` is atomic on POSIX: two processes racing to create the same
// path, exactly one wins. A lease is only ever stolen from a holder the OS
// says no longer exists — never from one that is merely quiet.
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import type { InstanceLease } from '../contract/index.js';

export interface FileInstanceLeaseOptions {
  /** `.novakai/` root. The lock lives under runtime/, which is not durable truth. */
  readonly root: string;
  readonly hostPid?: number;
  /** Overridable so a test can decide which pids are alive. */
  readonly isAlive?: (processId: number) => boolean;
}

interface LockFileContents {
  readonly hostPid: number;
  readonly startedAt: string;
}

export function createFileInstanceLease(options: FileInstanceLeaseOptions): InstanceLease {
  const hostPid = options.hostPid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const lockPath = path.join(options.root, 'runtime', 'runtime.lock');
  let holding = false;

  function readHolder(): LockFileContents | null {
    if (!existsSync(lockPath)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Partial<LockFileContents>;
      const holder = record.hostPid;
      if (typeof holder !== 'number') return null;
      return { hostPid: holder, startedAt: String(record.startedAt ?? '') };
    } catch {
      // A torn or hand-edited lock cannot prove anyone owns anything.
      return null;
    }
  }

  function claim(): boolean {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      const handle = openSync(lockPath, 'wx');
      writeSync(handle, JSON.stringify({ hostPid, startedAt: new Date().toISOString() }));
      closeSync(handle);
      holding = true;
      return true;
    } catch {
      return false;
    }
  }

  return {
    acquire() {
      const existing = readHolder();
      if (existing?.hostPid === hostPid) {
        holding = true;
        return { held: true };
      }
      if (existing !== null && isAlive(existing.hostPid)) {
        holding = false;
        return { held: false, holderPid: existing.hostPid };
      }
      if (existing !== null) {
        // The recorded holder is provably gone; its lock is debris.
        try { unlinkSync(lockPath); } catch { /* another host got there first */ }
      }
      if (claim()) return { held: true };
      const after = readHolder();
      holding = false;
      return after === null
        ? { held: false, holderPid: -1 }
        : { held: false, holderPid: after.hostPid };
    },

    release() {
      if (!holding) return;
      holding = false;
      const existing = readHolder();
      if (existing?.hostPid !== hostPid) return;
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    },

    heldByThisProcess() {
      if (!holding) return false;
      return readHolder()?.hostPid === hostPid;
    },

    holderPid() {
      return readHolder()?.hostPid ?? null;
    },

    holderAlive() {
      const existing = readHolder();
      return existing !== null && isAlive(existing.hostPid);
    },
  };
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}
