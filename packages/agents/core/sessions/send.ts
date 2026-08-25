import type { AgentId, SessionId } from '@novakai/foundation/dist/contract/brands.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import type { AgentsContext } from '../composition.js';
import { fireInjectionTrace, mergeInput, runEventHooks } from '../hooks/engine.js';
import * as registry from '../registry/registry.js';

/** Queue one turn on a known logical runtime session, preserving Agent hooks. */
export async function sendToSession(
  ctx: AgentsContext,
  sessionId: SessionId,
  input: string,
): Promise<boolean> {
  const meta = ctx.sessions.get(sessionId);
  const adapter = meta
    ? ctx.adapters[meta.provider]
    : Object.values(ctx.adapters).find((candidate) => candidate.attach(sessionId));
  if (!adapter) return false;
  let out = input;
  if (meta) {
    const found = await registry.getAgent(ctx, meta.agentId as AgentId);
    if (found.ok && !isAbsent(found.value)) {
      const pending = ctx.pendingInjections.get(sessionId) ?? [];
      ctx.pendingInjections.delete(sessionId);
      const pre = await runEventHooks(
        ctx,
        found.value,
        'onMessagePre',
        { sessionId, messageText: input },
      );
      const injections = [...pending, ...pre.injections];
      out = mergeInput(injections, input);
      const sent = adapter.send(sessionId, out);
      if (sent) {
        for (const injection of injections) await fireInjectionTrace(ctx, injection);
      } else if (injections.length > 0) {
        ctx.pendingInjections.set(sessionId, [
          ...injections,
          ...(ctx.pendingInjections.get(sessionId) ?? []),
        ]);
      }
      const post = await runEventHooks(
        ctx,
        found.value,
        'onMessagePost',
        { sessionId, messageText: input },
      );
      if (post.injections.length > 0) {
        ctx.pendingInjections.set(sessionId, [
          ...(ctx.pendingInjections.get(sessionId) ?? []),
          ...post.injections,
        ]);
      }
      return sent;
    }
  }
  return adapter.send(sessionId, out);
}

/** Resolve an Agent's newest logical runtime session without exposing its key. */
export function sendToAgent(
  ctx: AgentsContext,
  agentId: AgentId,
  input: string,
): Promise<boolean> {
  const session = [...ctx.sessions.entries()].reverse().find(([, value]) =>
    value.agentId === agentId)?.[0];
  return session === undefined
    ? Promise.resolve(false)
    : sendToSession(ctx, session as SessionId, input);
}
