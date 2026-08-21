// packages/server/core/door/provision.ts — agent identity provisioning, shared
// by the ws methods (spawn/create paths) and the HTTP door (external register).
//
// Moved verbatim from methods.ts closures so the door and the shell travel the
// SAME provisioning path (red gate 23: similar callers, one policy path).
import { randomUUID } from 'node:crypto';
import type { ProviderName } from '../../contract/config.js';
import type { ServerRuntime } from '../methods.js';

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
 * DEC-B1-8: no pools. An agent that can hold conversations binds exactly ONE
 * person, provisioned through config, idempotently (existing binding reused,
 * never duplicated) — and the person opens its own door to Chris (DEC-14:
 * each principal owns its ContactPolicy).
 */
export async function ensureAgentPerson(runtime: ServerRuntime, agentId: string): Promise<string> {
  const config = runtime.configStore.current();
  const bound = config.bindings.find((binding) => binding.agentId === agentId);
  if (bound) {
    await openContactPolicy(runtime, bound.personId);
    return bound.personId;
  }
  const personId = `person_a${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  // A messaging-only principal writes no objects: an empty grant set is the
  // honest scope, not a borrowed one.
  const token = runtime.configStore.mintPrincipalToken({ personId, roles: ['Worker'], grants: [] });
  await runtime.configStore.set(
    { configKind: 'principal', personId, roles: ['Worker'], tokenId: token.id },
    runtime.mintOpId() as never,
  );
  await runtime.configStore.set(
    { configKind: 'agentPersonBinding', agentId, personId },
    runtime.mintOpId() as never,
  );
  await openContactPolicy(runtime, personId);
  await allowHumanToReach(runtime, personId);
  return personId;
}

/** The agent person allows Chris and denies everyone else (demo pattern). */
export async function openContactPolicy(runtime: ServerRuntime, personId: string): Promise<void> {
  const holder = await runtime.holderForPerson(personId);
  if (!holder) return;
  await holder.call((session) => (session as { setContactPolicy(policy: object): Promise<unknown> })
    .setContactPolicy({ allowlist: [runtime.human.personId], defaultRule: 'deny' }));
}

/** Chris's own allowlist grows to include every provisioned agent person. */
export async function allowHumanToReach(runtime: ServerRuntime, _personId: string): Promise<void> {
  const others = runtime.configStore.current().principals
    .map((principal) => principal.personId)
    .filter((id) => id !== runtime.human.personId);
  await runtime.human.holder.call((session) => (session as { setContactPolicy(policy: object): Promise<unknown> })
    .setContactPolicy({ allowlist: others, defaultRule: 'deny' }));
}

export interface RegisteredExternalAgent {
  agentId: string;
  personId: string;
  /** The bearer the external session presents on every later door call. */
  token: string;
}

/**
 * The door's register verb: an agent running in a terminal Chris opened (not a
 * managed PTY) enrolls itself — same ensureAgent/ensureAgentPerson path a
 * spawned conversation takes, plus a freshly minted bearer of its own so later
 * sends authenticate as the agent, never as Chris.
 */
export async function registerExternalAgent(
  runtime: ServerRuntime, displayName: string, provider: ProviderName,
): Promise<RegisteredExternalAgent> {
  const agentId = await ensureAgent(runtime, displayName, provider);
  const personId = await ensureAgentPerson(runtime, agentId);
  // ensureAgentPerson mints only for a NEW binding and never returns the
  // bearer; an external session needs one in hand every time it registers.
  const token = runtime.configStore.mintPrincipalToken({ personId, roles: ['Worker'], grants: [] });
  await runtime.configStore.set(
    { configKind: 'principal', personId, roles: ['Worker'], tokenId: token.id },
    runtime.mintOpId() as never,
  );
  return { agentId, personId, token: token.bearer };
}
