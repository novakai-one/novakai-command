// Agent identity provisioning shared by the ws methods (spawn/create paths).
import { randomUUID } from 'node:crypto';
import type { ProviderName } from '../../contract/config.js';
import type { ServerRuntime } from './runtime.js';

/**
 * G4 lesson, promoted (§9): look the definition up by displayName+provider
 * before defining, so a restart never appends a duplicate agent.
 */
export async function ensureAgent(
  runtime: ServerRuntime, displayName: string, provider: ProviderName,
): Promise<string> {
  const listed = await runtime.agents.listAgents() as
    { ok: boolean; value?: { items: Array<{ id: string; displayName: string; provider: string; status: string }> } };
  const existing = listed.ok
    ? listed.value?.items.find((item) => item.displayName === displayName && item.provider === provider && item.status !== 'archived')
    : undefined;
  if (existing) return existing.id;
  const defined = await runtime.agents.defineAgent(
    { displayName, provider, model: runtime.configStore.current().providers[provider].defaultModel },
    runtime.mintOpId() as never,
  ) as { ok: boolean; value?: { id: string }; error?: { message: string } };
  if (!defined.ok || !defined.value) throw new Error(`defineAgent failed: ${defined.error?.message ?? 'unknown'}`);
  return defined.value.id;
}

/**
 * An agent that can hold conversations binds exactly ONE person, provisioned
 * through config, idempotently (existing binding reused, never duplicated).
 */
export async function ensureAgentPerson(runtime: ServerRuntime, agentId: string): Promise<string> {
  const config = runtime.configStore.current();
  const bound = config.bindings.find((binding) => binding.agentId === agentId);
  if (bound) return bound.personId;
  const personId = `person_a${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const token = runtime.configStore.mintPrincipalToken({ personId, roles: ['Worker'], grants: [] });
  await runtime.configStore.set(
    { configKind: 'principal', personId, roles: ['Worker'], tokenId: token.id },
    runtime.mintOpId() as never,
  );
  await runtime.configStore.set(
    { configKind: 'agentPersonBinding', agentId, personId },
    runtime.mintOpId() as never,
  );
  return personId;
}
