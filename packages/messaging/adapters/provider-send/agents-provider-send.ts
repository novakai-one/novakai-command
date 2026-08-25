import type {
  ProviderDispatchResult,
  ProviderSend,
  ProviderSendInput,
} from '../../contract/ports/provider-send.js';

interface AgentsSendDoor {
  dispatchProviderTurn(input: never): Promise<unknown>;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

const providerInput = (input: ProviderSendInput): string => input.screenContext === undefined
  ? input.text
  : `[novakai context] ${JSON.stringify(input.screenContext)}\n${input.text}`;

/** Adapts the sole Agents contract to provider execution; stdout is ignored. */
export function createAgentsProviderSend(agents: AgentsSendDoor): ProviderSend {
  return {
    async dispatch(input): Promise<ProviderDispatchResult> {
      const dispatchedAt = new Date().toISOString();
      const outcome = object(await agents.dispatchProviderTurn({
        agentId: input.targetAgentId,
        text: providerInput(input),
        ...(input.resumeId === undefined ? {} : { resumeId: input.resumeId }),
      } as never));
      const error = object(outcome?.error);
      return outcome?.ok === true
        ? { ok: true, dispatchedAt }
        : {
            ok: false,
            code: 'ProviderSessionUnavailable',
            message: typeof error?.message === 'string'
              ? error.message
              : `Agent ${input.targetAgentId} provider runtime is unavailable`,
          };
    },
  };
}
