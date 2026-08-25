import type { AgentDirectory } from '../ports/agent-directory.js';

interface AgentsContractDoor {
  getAgent(agentId: never): Promise<unknown>;
  attachProviderSession(input: never): Promise<unknown>;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const supportedProvider = (
  value: string,
): value is 'claude' | 'codex' | 'kimi' => value === 'claude' || value === 'codex' || value === 'kimi';

/** Binds Messaging to the sole public Agents contract. */
export function createAgentDirectory(agents: AgentsContractDoor): AgentDirectory {
  return {
    async get(agentId) {
      const result = object(await agents.getAgent(agentId as never));
      const found = object(result?.value);
      if (result?.ok !== true || found === undefined
        || found.absent === true || !supportedProvider(String(found.provider))) return null;
      return {
        agentId: String(found.id),
        provider: found.provider as 'claude' | 'codex' | 'kimi',
        currentProviderSessionId: typeof found.sessionId === 'string' ? found.sessionId : null,
      };
    },
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
