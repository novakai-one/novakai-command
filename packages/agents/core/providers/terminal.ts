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
  provider: ProviderName;
  state: 'running' | 'exited';
  closedByUs: boolean;
  handlers: Array<(e: PtyEvent) => void>;
}

export function createTerminalAdapter(
  runtime: TerminalRuntimeLike,
  defaults: { cwd: string },
): TerminalAdapter {
  const sessions = new Map<string, SessionRecord>();
  const byAgentId = new Map<string, SessionRecord>();

  const emit = (rec: SessionRecord, e: PtyEvent): void => {
    for (const h of rec.handlers) h(e);
  };

  // The runtime's data/exit callbacks are GLOBAL (one registration each) —
  // register once, demux by agentId.
  let wired = false;
  const wire = (): void => {
    if (wired) return;
    wired = true;
    runtime.onData((agentId, data) => {
      const rec = byAgentId.get(agentId);
      if (rec) emit(rec, { type: 'output', sessionId: rec.sessionId, at: new Date().toISOString(), data });
    });
    runtime.onExit((agentId, exitCode) => {
      const rec = byAgentId.get(agentId);
      if (!rec) return;
      rec.state = 'exited';
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
        agentId,
      });
      const rec: SessionRecord = {
        sessionId, agentId: info.agentId, provider,
        state: 'running', closedByUs: false, handlers: [],
      };
      sessions.set(sessionId, rec);
      byAgentId.set(info.agentId, rec);
      if (info.terminalPid !== undefined) {
        queueMicrotask(() => emit(rec, {
          type: 'spawned', sessionId, at: new Date().toISOString(), pid: info.terminalPid!,
        }));
      }
      return { sessionId, agentId: info.agentId, provider, model: opts.model ?? '' };
    },
    attach(sessionId) {
      const rec = sessions.get(sessionId);
      return rec ? { sessionId, state: rec.state } : null;
    },
    send(sessionId, input) {
      const rec = sessions.get(sessionId);
      return rec ? runtime.write(rec.agentId, input) : false;
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
      return runtime.kill(rec.agentId);
    },
  };
}

// Per-provider factories (DEC-C2): one adapter each, zero core changes to add
// a fourth provider. Today they share the terminal host because all three CLIs
// are PTY-driven; the seam is what AGT-001/R3-28 ratifies.
export const createKimiAdapter = (runtime: TerminalRuntimeLike, cwd: string): TerminalAdapter =>
  createTerminalAdapter(runtime, { cwd });
export const createClaudeAdapter = createKimiAdapter;
export const createCodexAdapter = createKimiAdapter;
