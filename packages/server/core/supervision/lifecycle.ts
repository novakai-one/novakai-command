// packages/server/core/supervision/lifecycle.ts — terminate / restart /
// compact (DEC-B1-13; split from engine.ts, SUPFIX step 0).
import type { LifecycleResult, SupervisionInternals } from './types.js';

const notFound = (sessionId: string): LifecycleResult => ({
  ok: false,
  error: { code: 'SessionNotFound', message: `no providerSession "${sessionId}"` },
});

export function createLifecycle(internals: SupervisionInternals): {
  terminate(sessionId: string, reason: string, clientOpId?: string): Promise<LifecycleResult>;
  respawn(sessionId: string, carryContext: boolean): Promise<LifecycleResult>;
} {
  const { deps, now, traced, driftStates, driftFlags } = internals;

  async function terminate(
    sessionId: string,
    reason: string,
    clientOpId?: string,
  ): Promise<LifecycleResult> {
    const record = await deps.sessions.get(sessionId);
    if (!record) return notFound(sessionId);
    deps.lifecycle.closeSession(sessionId);
    const closed = await deps.sessions.close(sessionId, 'closed');
    driftStates.delete(sessionId);
    driftFlags.delete(sessionId);
    deps.usage.forget(sessionId);
    await traced('session.terminate', sessionId, { agentId: record.agentId, reason }, clientOpId);
    if (!closed.ok) {
      return { ok: false, error: { code: 'RegistryWriteFailed', message: `could not close "${sessionId}"` } };
    }
    return { ok: true, sessionId };
  }

  /**
   * DEC-B1-13. restart CARRIES the provider conversation id (the work
   * continues); compact DROPS it. Chris asked for "terminate after any
   * meaningful work and re-start… compact as an option" — this is both halves,
   * and the difference between them is exactly one field.
   */
  const respawn = async (sessionId: string, carryContext: boolean): Promise<LifecycleResult> => {
    const record = await deps.sessions.get(sessionId);
    if (!record) return notFound(sessionId);
    const ended = await terminate(sessionId, carryContext ? 'restart' : 'compact');
    if (!ended.ok) return ended;
    const fresh = await deps.lifecycle.spawnFresh({
      agentId: record.agentId,
      provider: record.provider,
      cwd: record.cwd,
      resumeFrom: carryContext ? record.providerConversationId : null,
    });
    if (!fresh.ok) return { ok: false, error: fresh.error };
    const mechanism = 'restart-fresh' as const;
    const resumedFrom = fresh.value.resumed ? record.providerConversationId : null;
    // A cumulative provider transcript already contains the old session's
    // spend. Prime the baseline now, before the caller can send the first
    // post-restart turn; baselining on the next usage tick would erase that
    // first turn by clamping its delta to zero.
    deps.usage.trackSession(fresh.value.sessionId, {
      threadPreexisting: fresh.value.resumed,
    });
    if (fresh.value.resumed && resumedFrom) {
      await deps.usage.read({
        sessionId: fresh.value.sessionId,
        provider: record.provider,
        providerConversationId: resumedFrom,
        cwd: record.cwd,
      });
    }
    await traced(carryContext ? 'supervision.restart' : 'supervision.compact', fresh.value.sessionId, {
      agentId: record.agentId, previousSessionId: sessionId,
      resumed: fresh.value.resumed,
      resumedFrom,
      mechanism,
    });
    return { ok: true, sessionId: fresh.value.sessionId, mechanism };
  };

  return { terminate, respawn };
}
