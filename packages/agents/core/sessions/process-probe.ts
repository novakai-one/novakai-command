// OS process liveness probe.
//
// Internal seam: "is this pid still alive, and is it still the process we
// spawned?" Production probes the OS; tests inject a fake. Two real adapters,
// so the seam earns its place.
import { execFileSync } from 'node:child_process';

export interface ProcessProbe {
  alive(pid: number): boolean;
  /** The OS-reported start time, or null when it cannot be read. */
  startedAt(pid: number): string | null;
  kill?(pid: number): void;
}

export const osProcessProbe: ProcessProbe = {
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  startedAt(pid) {
    try {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null;
    } catch { return null; }
  },
  kill(pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone — nothing to reap */ }
  },
};
