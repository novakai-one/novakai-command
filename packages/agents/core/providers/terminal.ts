// Terminal-host adapter (kimi | claude | codex): wraps the EXISTING terminal
// host (TerminalManager in-process, or TerminalHostClient over the unix socket
// — both satisfy TerminalRuntimeLike). The provider CLI argv/env/discovery is
// the terminal capability's job (src/backend/terminal/provider/); this adapter
// only chooses the provider name and demuxes the runtime's global callbacks
// into per-session PtyEvent streams (R3-15/R3-17).
import { randomUUID } from 'node:crypto';
import type { PtyEvent, ProviderName, SpawnOpts, Unsubscribe } from '../../contract/schemas.js';
import type { SpawnedSession, TerminalAdapter, TerminalRuntimeLike } from './adapter.js';

interface SessionRecord {
  sessionId: string;
  agentId: string;
  /** S3: the runtime keys terminals by its own agentId string, so each session
   * gets a UNIQUE runtime key (the sessionId) — a second spawn of the same
   * agent can never overwrite the first session's routing. */
  runtimeKey: string;
  provider: ProviderName;
  state: 'running' | 'exited';
  closedByUs: boolean;
  handlers: Array<(e: PtyEvent) => void>;
  /** S2b activity heuristic (ruling 12): last emitted activity time + idle timer. */
  lastActivityAt: number;
  idle: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** Ruling 12 defaults: ≤1 activity event per 2s per session; 5s quiet → idle. */
export interface ActivityHeuristicOpts {
  activityIntervalMs?: number;
  idleMs?: number;
}

export function createTerminalAdapter(
  runtime: TerminalRuntimeLike,
  defaults: { cwd: string; provider?: ProviderName },
  heuristic: ActivityHeuristicOpts = {},
): TerminalAdapter {
  const activityIntervalMs = heuristic.activityIntervalMs ?? 2000;
  const idleMs = heuristic.idleMs ?? 5000;
  const sessions = new Map<string, SessionRecord>();
  const byRuntimeKey = new Map<string, SessionRecord>();

  /**
   * S2a (§22 ruling 5): per-provider DECLARED skills mechanism.
   * - kimi: native `--skills-dir <dir>` CLI flag (verified via `kimi --help`).
   * - claude/codex: NOVAKAI_SKILLS env (colon-joined dirs) — declared
   *   mechanism; native support unverified, recorded in NOTES.md.
   */
  const skillsSpawnConfig = (provider: ProviderName, dirs: string[]):
    { argv?: string[]; env?: Record<string, string> } => {
    if (dirs.length === 0) return {};
    if (provider === 'kimi') return { argv: dirs.flatMap((d) => ['--skills-dir', d]) };
    return { env: { NOVAKAI_SKILLS: dirs.join(':') } };
  };

  const emit = (rec: SessionRecord, e: PtyEvent): void => {
    for (const h of rec.handlers) h(e);
  };

  /**
   * S2b (DEC-S2-15, ruling 12): derive activity from raw output. A chunk while
   * the window has elapsed emits ONE 'working' signal; a quiet window emits
   * ONE 'idle'. Adapter-internal heuristic — the contract sees only the
   * standard PtyEvent shape.
   */
  const noteOutput = (rec: SessionRecord): void => {
    const now = Date.now();
    if (rec.idle || now - rec.lastActivityAt >= activityIntervalMs) {
      rec.lastActivityAt = now;
      rec.idle = false;
      emit(rec, { type: 'activity', sessionId: rec.sessionId, at: new Date().toISOString(), activity: 'working' });
    }
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => {
      if (rec.state !== 'running' || rec.idle) return;
      rec.idle = true;
      emit(rec, { type: 'activity', sessionId: rec.sessionId, at: new Date().toISOString(), activity: 'idle' });
    }, idleMs);
  };

  const clearHeuristic = (rec: SessionRecord): void => {
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    rec.idleTimer = null;
  };

  // The runtime's data/exit callbacks are GLOBAL (one registration each) —
  // register once, demux by the per-session runtime key (S3), never agentId.
  let wired = false;
  const wire = (): void => {
    if (wired) return;
    wired = true;
    runtime.onData((runtimeKey, data) => {
      const rec = byRuntimeKey.get(runtimeKey);
      if (rec) {
        emit(rec, { type: 'output', sessionId: rec.sessionId, at: new Date().toISOString(), data });
        noteOutput(rec);
      }
    });
    runtime.onExit((runtimeKey, exitCode) => {
      const rec = byRuntimeKey.get(runtimeKey);
      if (!rec) return;
      rec.state = 'exited';
      clearHeuristic(rec);
      emit(rec, {
        type: 'exited', sessionId: rec.sessionId, at: new Date().toISOString(),
        code: exitCode, signal: null,
      });
    });
  };

  return {
    async spawn(agentId, provider, opts): Promise<SpawnedSession> {
      if (provider === 'mock') throw new Error('mock provider must use the mock adapter');
      wire();
      const sessionId = `sess_${randomUUID()}`;
      const info = await runtime.create({
        title: `agent:${agentId}`,
        cwd: opts.cwd ?? defaults.cwd,
        provider,
        agentId: sessionId, // S3: unique per-session runtime key
        ...(opts.model ? { model: opts.model } : {}), // OD-C3: at-spawn model reaches capable runtimes
        ...skillsSpawnConfig(provider, opts.skills ?? []),
      });
      const rec: SessionRecord = {
        sessionId, agentId, runtimeKey: info.agentId, provider,
        state: 'running', closedByUs: false, handlers: [],
        lastActivityAt: 0, idle: false, idleTimer: null,
      };
      sessions.set(sessionId, rec);
      byRuntimeKey.set(info.agentId, rec);
      if (info.terminalPid !== undefined) {
        queueMicrotask(() => emit(rec, {
          type: 'spawned', sessionId, at: new Date().toISOString(), pid: info.terminalPid!,
        }));
      }
      return { sessionId, agentId, provider, model: opts.model ?? '' };
    },
    attach(sessionId) {
      const rec = sessions.get(sessionId);
      return rec ? { sessionId, state: rec.state } : null;
    },
    send(sessionId, input) {
      const rec = sessions.get(sessionId);
      return rec ? runtime.write(rec.runtimeKey, input) : false;
    },
    subscribe(sessionId, handler): Unsubscribe {
      const rec = sessions.get(sessionId);
      if (!rec) return () => undefined;
      rec.handlers.push(handler);
      return () => {
        rec.handlers = rec.handlers.filter((h) => h !== handler);
      };
    },
    close(sessionId) {
      const rec = sessions.get(sessionId);
      if (!rec) return false;
      rec.closedByUs = true;
      clearHeuristic(rec);
      return runtime.kill(rec.runtimeKey);
    },
    // OD-C3 RULED: expose model-switch ONLY when the runtime declares the
    // mechanism (kimi CLI). Other runtimes → no method → typed
    // UnsupportedOperation at the contract layer.
    ...(runtime.setModel
      ? {
        setSessionModel(sessionId: string, model: string): boolean {
          const rec = sessions.get(sessionId);
          if (!rec) return false;
          return runtime.setModel!(rec.runtimeKey, model);
        },
      }
      : {}),
  };
}

// Per-provider factories (DEC-C2): one adapter each, zero core changes to add
// a fourth provider. Today they share the terminal host because all three CLIs
// are PTY-driven; the seam is what AGT-001/R3-28 ratifies.
export const createKimiAdapter = (runtime: TerminalRuntimeLike, cwd: string): TerminalAdapter =>
  createTerminalAdapter(runtime, { cwd, provider: 'kimi' });
export const createClaudeAdapter = (runtime: TerminalRuntimeLike, cwd: string): TerminalAdapter =>
  createTerminalAdapter(runtime, { cwd, provider: 'claude' });
export const createCodexAdapter = (runtime: TerminalRuntimeLike, cwd: string): TerminalAdapter =>
  createTerminalAdapter(runtime, { cwd, provider: 'codex' });
