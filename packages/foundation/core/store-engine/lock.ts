// Global mutation lock (.novakai/lock) — ported from audit-verified
// src/backend/stores/store.mjs (Delta-S2 owner-token + pid-liveness takeover).
// One hold guards the object-append + trace-append pair (R3-2). Bounded wait,
// default 5 s (§0); timeout → caller maps to typed LockBusy. Never infinite block.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Lock { lockDir: string; token: string }

export class LockTimeout extends Error {
  constructor(public readonly waitedMs: number, public readonly timeoutMs: number) {
    super(`mutation lock held by a live process — timed out after ${timeoutMs}ms`);
    this.name = 'LockTimeout';
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockOwner(lockDir: string): { pid?: number; token?: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null; // mid-acquisition or unreadable — treat as alive/unknown
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** One acquisition attempt: the Lock on success, 'busy' while a live holder exists. */
function tryAcquire(lockDir: string, token: string): Lock | 'busy' | 'retry' {
  try {
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token }) + '\n');
    return { lockDir, token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = readLockOwner(lockDir);
    if (owner && Number.isInteger(owner.pid) && !isPidAlive(owner.pid as number)) {
      rmSync(lockDir, { recursive: true, force: true }); // dead holder — contenders re-race
      return 'retry';
    }
    return 'busy';
  }
}

export function acquireLock(root: string, { timeoutMs = 5000, pollMs = 50 } = {}): Lock {
  const lockDir = path.join(root, 'lock');
  const token = randomUUID();
  const start = Date.now();
  const deadline = start + timeoutMs;
  for (;;) {
    const attempt = tryAcquire(lockDir, token);
    if (attempt === 'retry') continue;
    if (attempt !== 'busy') return attempt;
    if (Date.now() >= deadline) throw new LockTimeout(Date.now() - start, timeoutMs);
    sleepSync(pollMs);
  }
}

/** Same protocol as acquireLock, but waits in the timer queue — the event loop
 * (HTTP, signal handlers) stays live while this contender queues. */
export async function acquireLockAsync(root: string, { timeoutMs = 5000, pollMs = 50 } = {}): Promise<Lock> {
  const lockDir = path.join(root, 'lock');
  const token = randomUUID();
  const start = Date.now();
  const deadline = start + timeoutMs;
  for (;;) {
    const attempt = tryAcquire(lockDir, token);
    if (attempt === 'retry') continue;
    if (attempt !== 'busy') return attempt;
    if (Date.now() >= deadline) throw new LockTimeout(Date.now() - start, timeoutMs);
    await sleep(pollMs);
  }
}

export function releaseLock(lock: Lock): void {
  const owner = readLockOwner(lock.lockDir);
  if (owner?.token !== lock.token) return; // stale token — never break another's lock
  rmSync(lock.lockDir, { recursive: true, force: true });
}
