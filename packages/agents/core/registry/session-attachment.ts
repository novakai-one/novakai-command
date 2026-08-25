import {
  getObject,
  isAbsent,
  listObjects,
  updateObject,
} from '@novakai/foundation/dist/contract/index.js';
import type {
  AgentId,
  ClientOpId,
  ObjectId,
} from '@novakai/foundation/dist/contract/brands.js';
import { err, type StoreError } from '@novakai/foundation/dist/contract/errors.js';
import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type { AgentDefinitionT } from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';
import { normalizeAgent } from './registry.js';

/** Complete input to the Agents-owned session-pointer transition. */
export interface AttachProviderSessionInput {
  readonly agentId: AgentId;
  readonly providerSessionId: string;
  readonly expectedSessionId: string | null;
  readonly clientOpId: ClientOpId;
}

/** Equal replays are observable successes rather than duplicate mutations. */
export interface AttachProviderSessionOutcome {
  readonly state: 'attached' | 'already-attached';
  readonly agent: AgentDefinitionT;
}

const tails = new WeakMap<AgentsContext, Promise<unknown>>();

function serialise<T>(ctx: AgentsContext, action: () => Promise<T>): Promise<T> {
  const prior = tails.get(ctx) ?? Promise.resolve();
  const run = prior.then(action, action);
  tails.set(ctx, run.then(() => undefined, () => undefined));
  return run;
}

const failure = (code: StoreError['code'], message: string, details: StoreError['details']): Result<never, StoreError> => ({
  ok: false,
  error: err(code, message, details, false) as StoreError,
});

async function perform(
  ctx: AgentsContext,
  input: AttachProviderSessionInput,
): Promise<Result<AttachProviderSessionOutcome, StoreError>> {
  const listed = await listObjects<AgentDefinitionT>(
    ctx.handle,
    'agent',
    undefined,
    { limit: 10_000 },
  );
  if (!listed.ok) return listed;
  const owner = listed.value.items.find(({ object }) => {
    const candidate = normalizeAgent(object);
    return candidate !== null
      && candidate.id !== input.agentId
      && (candidate.sessionId === input.providerSessionId
        || candidate.sessions.includes(input.providerSessionId));
  });
  if (owner !== undefined) {
    return failure('CasConflict', `ProviderSession "${input.providerSessionId}" is already attached`, {
      id: input.providerSessionId as ObjectId,
      expectedVersion: 0,
      actualVersion: owner.version,
    });
  }

  const found = await getObject<AgentDefinitionT>(
    ctx.handle,
    'agent',
    input.agentId as unknown as ObjectId,
  );
  if (!found.ok) return found;
  if (isAbsent(found.value)) {
    return failure('NotFound', `no agent with id "${input.agentId}"`, {
      ref: { kind: 'agent', id: input.agentId },
    });
  }
  const agent = normalizeAgent(found.value.object);
  if (agent === null) {
    return failure('InvalidEnvelope', `agent "${input.agentId}" failed normalization`, {
      missingFields: [],
      invalidFields: [{ field: 'agent', reason: 'normalization failed' }],
    });
  }
  if (agent.sessionId === input.providerSessionId) {
    return { ok: true, value: { state: 'already-attached', agent } };
  }
  if ((agent.sessionId ?? null) !== input.expectedSessionId) {
    return failure('CasConflict', `agent "${input.agentId}" current session changed`, {
      id: input.agentId as unknown as ObjectId,
      expectedVersion: found.value.version,
      actualVersion: found.value.version,
    });
  }
  const sessions = agent.sessionId === undefined
    ? agent.sessions
    : [...new Set([...agent.sessions, agent.sessionId])];
  const updated = await updateObject<AgentDefinitionT>(
    ctx.handle,
    input.agentId as unknown as ObjectId,
    { sessionId: input.providerSessionId, sessions },
    found.value.version,
    input.clientOpId,
  );
  if (!updated.ok) return updated;
  const normalized = normalizeAgent(updated.value.object);
  if (normalized === null) {
    return failure('InvalidEnvelope', `agent "${input.agentId}" failed normalization after attachment`, {
      missingFields: [],
      invalidFields: [{ field: 'agent', reason: 'normalization failed' }],
    });
  }
  return { ok: true, value: { state: 'attached', agent: normalized } };
}

/** Attaches one ProviderSession under Agents authority and serialises competing claims. */
export function attachProviderSession(
  ctx: AgentsContext,
  input: AttachProviderSessionInput,
): Promise<Result<AttachProviderSessionOutcome, StoreError>> {
  return serialise(ctx, () => perform(ctx, input));
}
