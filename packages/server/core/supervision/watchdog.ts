// packages/server/core/supervision/watchdog.ts — B1a supervision stub: the
// watchdog HOOK only (packet item 7). The full supervision engine — skills
// gate, drift check-ins, usage table — is B1b (§8).
//
// scripts/agent-watchdog.mjs keeps its session list in `.watchdog-sessions.json`
// (its own documented registry, OUTSIDE `.novakai/`). §13 disposition 1 makes
// that script READ-ONLY with respect to `.novakai/`; it says nothing about its
// own registry, which is exactly the file it needs somebody to populate. So the
// server registers every session it spawns here, and the watchdog's `table`
// verb shows real sessions without the script being modified at all.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface WatchdogEntry {
  sessionId: string;
  provider: string;
  task: string;
  startedAt: string;
  transcriptPath: string | null;
  cwd: string;
  status: 'active' | 'closed';
  endedAt: string | null;
}

export interface WatchdogHook {
  register(entry: Omit<WatchdogEntry, 'startedAt' | 'status' | 'endedAt'> & { startedAt?: string }): void;
  close(sessionId: string): void;
  entries(): WatchdogEntry[];
  readonly registryPath: string;
}

/**
 * @param registryDir directory holding `.watchdog-sessions.json` — the dir the
 *        operator runs the watchdog from (the repo root in practice).
 */
export function createWatchdogHook(registryDir: string): WatchdogHook {
  const registryPath = path.join(registryDir, '.watchdog-sessions.json');

  const load = (): { sessions: WatchdogEntry[] } => {
    try {
      const data = JSON.parse(readFileSync(registryPath, 'utf8')) as { sessions?: WatchdogEntry[] };
      return Array.isArray(data.sessions) ? { sessions: data.sessions } : { sessions: [] };
    } catch {
      return { sessions: [] }; // absent or unreadable = empty, never a boot failure
    }
  };

  // Same atomic write the script uses, so a concurrent reader never sees a
  // half-written registry.
  const save = (registry: { sessions: WatchdogEntry[] }): void => {
    if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });
    const tmp = `${registryPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2));
    renameSync(tmp, registryPath);
  };

  return {
    registryPath,
    register(input) {
      const registry = load();
      const entry: WatchdogEntry = {
        sessionId: input.sessionId,
        provider: input.provider,
        task: input.task,
        startedAt: input.startedAt ?? new Date().toISOString(),
        transcriptPath: input.transcriptPath,
        cwd: input.cwd,
        status: 'active',
        endedAt: null,
      };
      const existing = registry.sessions.find((s) => s.sessionId === entry.sessionId);
      if (existing) Object.assign(existing, entry);
      else registry.sessions.push(entry);
      save(registry);
    },
    close(sessionId) {
      const registry = load();
      const existing = registry.sessions.find((s) => s.sessionId === sessionId);
      if (!existing) return;
      existing.status = 'closed';
      existing.endedAt = new Date().toISOString();
      save(registry);
    },
    entries: () => load().sessions,
  };
}
