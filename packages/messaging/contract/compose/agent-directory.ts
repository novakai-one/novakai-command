import { deriveClientOpId } from '@novakai/foundation/contract';
import type { AgentDirectory } from '../ports/agent-directory.js';
import type { ProviderSessionId } from '../types.js';

interface AgentsContractDoor {
  getAgent(agentId: never): Promise<unknown>;
  listAgents(): Promise<unknown>;
  defineAgent(input: never, clientOpId: never): Promise<unknown>;
  attachProviderSession(input: never): Promise<unknown>;
  providerTurnReadiness(agentId: never): 'idle' | 'busy' | 'unavailable';
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const supportedProvider = (
  value: string,
): value is 'claude' | 'codex' | 'kimi' => value === 'claude' || value === 'codex' || value === 'kimi';

function asEntry(value: unknown) {
  const found = object(value);
  const provider = String(found?.provider);
  if (found === undefined || found.absent === true || !supportedProvider(provider)) return null;
  return {
    agentId: String(found.id),
    provider,
    // This adapter is the anti-corruption layer for Agent facts, so it owns
    // the brand: anything beyond here treats the session id as contract-checked.
    currentProviderSessionId: typeof found.sessionId === 'string'
      ? found.sessionId as ProviderSessionId
      : null,
  } as const;
}

function ownsSession(value: unknown, sessionId: string): boolean {
  const found = object(value);
  return found?.sessionId === sessionId
    || Array.isArray(found?.sessions) && found.sessions.includes(sessionId);
}

const externalName = (provider: string, resumeId: string | undefined): string => {
  const suffix = resumeId === undefined ? 'session' : resumeId.slice(-8);
  return `External ${provider[0]?.toUpperCase() ?? ''}${provider.slice(1)} ${suffix}`;
};

async function ensureForSession(
  agents: AgentsContractDoor,
  input: Parameters<AgentDirectory['ensureForSession']>[0],
): ReturnType<AgentDirectory['ensureForSession']> {
  const listed = object(await agents.listAgents());
  const page = object(listed?.value);
  const items = Array.isArray(page?.items) ? page.items : [];
  const existing = items.find((candidate) => ownsSession(candidate, input.sessionId));
  const existingEntry = asEntry(existing);
  if (existing !== undefined) {
    return existingEntry?.provider === input.provider
      ? { ok: true, agent: existingEntry }
      : {
          ok: false,
          code: 'AgentProviderConflict',
          message: `ProviderSession ${input.sessionId} belongs to another provider`,
        };
  }

  const created = object(await agents.defineAgent({
    displayName: externalName(input.provider, input.resumeId),
    provider: input.provider,
    model: 'cli-default',
    origin: 'provider-spawned',
    teamId: input.assignment.teamId,
    missionId: input.assignment.missionId,
  } as never, deriveClientOpId(`messaging:adopt:${input.sessionId}`) as never));
  const agent = asEntry(created?.value);
  const error = object(created?.error);
  return created?.ok === true && agent !== null
    ? { ok: true, agent }
    : {
        ok: false,
        code: typeof error?.code === 'string' ? error.code : 'AgentCreationFailed',
        message: typeof error?.message === 'string'
          ? error.message : 'External Agent creation failed',
      };
}

/** Binds Messaging to the sole public Agents contract. */
export function createAgentDirectory(agents: AgentsContractDoor): AgentDirectory {
  return {
    async get(agentId) {
      const result = object(await agents.getAgent(agentId as never));
      const found = object(result?.value);
      if (result?.ok !== true || found === undefined
        || found.absent === true || !supportedProvider(String(found.provider))) return null;
      return asEntry(found);
    },
    async deliveryReadiness(agentId) {
      return agents.providerTurnReadiness(agentId as never);
    },
    ensureForSession: (input) => ensureForSession(agents, input),
    async attachProviderSession(agentId, providerSessionId, clientOpId) {
      const currentResult = object(await agents.getAgent(agentId as never));
      const current = object(currentResult?.value);
      if (currentResult?.ok !== true || current?.absent === true) {
        return { ok: false, code: 'AgentNotFound', message: `no agent with id "${agentId}"` };
      }
      const attached = object(await agents.attachProviderSession({
        agentId: agentId as never,
        providerSessionId,
        expectedSessionId: typeof current?.sessionId === 'string' ? current.sessionId : null,
        clientOpId: clientOpId as never,
      } as never));
      const value = object(attached?.value);
      const error = object(attached?.error);
      return attached?.ok === true && (value?.state === 'attached' || value?.state === 'already-attached')
        ? { ok: true, state: value.state }
        : {
            ok: false,
            code: typeof error?.code === 'string' ? error.code : 'AgentAttachmentFailed',
            message: typeof error?.message === 'string' ? error.message : 'Agent session attachment failed',
          };
    },
  };
}
