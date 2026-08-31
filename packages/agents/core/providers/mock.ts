// Mock provider adapter — proves the seam is replaceable; the adapter
// conformance suite runs against it. Fully in-memory; tests script PtyEvents.
import { randomUUID } from 'node:crypto';
import type { PtyEvent, ProviderName, SpawnOpts, Unsubscribe } from '../../contract/schemas.js';
import type { SpawnedSession, TerminalAdapter } from './adapter.js';

export interface MockSession {
  sessionId: string;
  agentId: string;
  provider: ProviderName;
  model: string;
  state: 'running' | 'exited';
  sent: string[];
  /** Resolved skill dirs received at spawn — the mock's
   * declared mechanism is to RECORD the list (observable proof). */
  skills: string[];
}

export interface MockTerminalAdapter extends TerminalAdapter {
  /** Script an event into a session's stream (test seam). */
  __emit(sessionId: string, e: PtyEvent): void;
  /** Everything send() wrote to the session. */
  __session(sessionId: string): MockSession | undefined;
  __sessions(): MockSession[];
}

export function createMockAdapter(): MockTerminalAdapter {
  const sessions = new Map<string, MockSession & { handlers: Array<(e: PtyEvent) => void> }>();

  const emit = (rec: { handlers: Array<(e: PtyEvent) => void> }, e: PtyEvent): void => {
    for (const h of rec.handlers) h(e);
  };

  const adapter: MockTerminalAdapter = {
    async spawn(agentId, provider, opts): Promise<SpawnedSession> {
      const sessionId = `sess_${randomUUID()}`;
      const rec = {
        sessionId, agentId, provider, model: opts.model ?? 'mock-model',
        state: 'running' as const, sent: [] as string[], skills: opts.skills ?? [],
        handlers: [] as Array<(e: PtyEvent) => void>,
      };
      sessions.set(sessionId, rec);
      queueMicrotask(() => emit(rec, {
        type: 'spawned', sessionId, at: new Date().toISOString(), pid: 4242,
      }));
      return { sessionId, agentId, provider, model: rec.model };
    },
    attach(sessionId) {
      const rec = sessions.get(sessionId);
      return rec ? { sessionId, state: rec.state } : null;
    },
    send(sessionId, input) {
      const rec = sessions.get(sessionId);
      if (!rec || rec.state !== 'running') return false;
      rec.sent.push(input);
      return true;
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
      if (rec.state === 'running') {
        rec.state = 'exited';
        queueMicrotask(() => emit(rec, {
          type: 'exited', sessionId, at: new Date().toISOString(), code: 0, signal: null,
        }));
      }
      return true;
    },
    __emit(sessionId, e) {
      const rec = sessions.get(sessionId);
      if (!rec) return;
      if (e.type === 'exited') rec.state = 'exited';
      emit(rec, e);
    },
    __session(sessionId) {
      return sessions.get(sessionId);
    },
    __sessions() {
      return [...sessions.values()];
    },
  };
  return adapter;
}
