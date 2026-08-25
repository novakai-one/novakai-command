/** Existing provider-session lifecycle and usage methods. */

import { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type { MethodTable } from '../../contract/protocol.js';
import { relinkConversation } from './lanes.js';
import type { ServerRuntime } from './runtime.js';

export function buildSessionMethods(runtime: ServerRuntime): MethodTable {
  return {
    async listSessions() {
      return runtime.sessions.list();
    },
    async terminateSession(params: never) {
      const input = params as { sessionId: string };
      const session = await runtime.sessions.get(input.sessionId);
      if (!session) {
        return {
          ok: false,
          error: { code: 'SessionNotFound', sessionId: input.sessionId },
        };
      }
      runtime.agents.closeSession(input.sessionId as never);
      const closed = await runtime.sessions.close(input.sessionId, 'closed');
      if (!closed.ok) return { ok: false, error: closed.error };
      runtime.watchdog.close(input.sessionId);
      for (const conversation of runtime.conversations.values()) {
        if (conversation.sessionId === input.sessionId) delete conversation.sessionId;
      }
      const traced = await recordSystemAction(runtime.persistence.handle, {
        action: 'session.terminate',
        target: { kind: 'session', id: input.sessionId },
        clientOpId: runtime.mintOpId() as never,
        meta: {
          refs: [
            { kind: 'session', id: input.sessionId },
            { kind: 'agent', id: session.agentId },
          ],
        },
      });
      if (!traced.ok) return { ok: false, error: traced.error };
      return { ok: true };
    },
    async getUsageTable() {
      return runtime.supervision.usageTable();
    },
    async restartSession(params: never) {
      const input = params as { sessionId: string };
      const result = await runtime.supervision.restart(input.sessionId);
      if (!result.ok) return { ok: false as const, error: result.error };
      relinkConversation(runtime, input.sessionId, result.sessionId);
      return { ok: true as const, sessionId: result.sessionId };
    },
    async compactSession(params: never) {
      const input = params as { sessionId: string };
      const result = await runtime.supervision.compact(input.sessionId);
      if (!result.ok) return { ok: false as const, error: result.error };
      relinkConversation(runtime, input.sessionId, result.sessionId);
      return {
        ok: true as const,
        sessionId: result.sessionId,
        mechanism: result.mechanism,
      };
    },
    async checkDrift() {
      return runtime.supervision.checkDrift();
    },
  };
}
