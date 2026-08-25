import type { AgentId, ClientOpId, SessionId } from '@novakai/foundation/dist/contract/brands.js';
import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type {
  ProviderTurnDispatch,
  ProviderTurnDispatchInput,
} from '../../contract/provider-turn.js';
import type { AgentsError } from '../../contract/errors.js';
import { spawnFailed } from '../../contract/errors.js';
import type { SpawnOpts, SpawnResponse } from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';
import * as registry from '../registry/registry.js';
import { sendToSession } from './send.js';

type Spawn = (
  agentId: AgentId,
  opts?: SpawnOpts,
  clientOpId?: ClientOpId,
) => Promise<Result<SpawnResponse, AgentsError>>;

const tails = new WeakMap<AgentsContext, Map<string, Promise<unknown>>>();

function serialise<T>(ctx: AgentsContext, agentId: string, action: () => Promise<T>): Promise<T> {
  const byAgent = tails.get(ctx) ?? new Map<string, Promise<unknown>>();
  tails.set(ctx, byAgent);
  const prior = byAgent.get(agentId) ?? Promise.resolve();
  const run = prior.then(action, action);
  byAgent.set(agentId, run.then(() => undefined, () => undefined));
  return run;
}

/** Lazily creates the private CLI runtime and queues exactly one provider turn. */
export function dispatchProviderTurn(
  ctx: AgentsContext,
  input: ProviderTurnDispatchInput,
  spawn: Spawn,
): Promise<Result<ProviderTurnDispatch, AgentsError>> {
  return serialise(ctx, input.agentId, async () => {
    let runtimeSessionId = [...ctx.sessions.entries()].reverse().find(([, value]) =>
      value.agentId === input.agentId)?.[0];
    let created = false;
    if (runtimeSessionId === undefined) {
      const spawned = await spawn(input.agentId);
      if (!spawned.ok) return spawned;
      runtimeSessionId = spawned.value.sessionId;
      created = true;
    }

    const meta = ctx.sessions.get(runtimeSessionId);
    if (meta === undefined) {
      return {
        ok: false,
        error: spawnFailed('mock', input.agentId, 'provider runtime registration disappeared'),
      };
    }
    if (created && input.resumeId !== undefined) {
      const found = await registry.getAgent(ctx, input.agentId);
      const model = found.ok && 'model' in found.value ? found.value.model : '';
      const adopted = ctx.adapters[meta.provider].adopt?.({
        sessionId: runtimeSessionId,
        agentId: input.agentId,
        provider: meta.provider,
        providerConversationId: input.resumeId,
        model,
        cwd: process.cwd(),
      }) ?? false;
      if (!adopted) {
        return {
          ok: false,
          error: spawnFailed(meta.provider, input.agentId, 'provider resume handle was refused'),
        };
      }
    }
    const queued = await sendToSession(ctx, runtimeSessionId as SessionId, input.text);
    return queued
      ? { ok: true, value: { state: 'queued', resumed: input.resumeId !== undefined } }
      : {
          ok: false,
          error: spawnFailed(meta.provider, input.agentId, 'provider turn was not queued'),
        };
  });
}
