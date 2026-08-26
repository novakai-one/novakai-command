import type {
  ProviderDispatchResult,
  ProviderSend,
  ProviderSendInput,
} from '../../contract/ports/provider-send.js';

interface AgentsSendDoor {
  executeProviderTurn(input: never): Promise<unknown>;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

const providerInput = (input: ProviderSendInput): string => input.screenContext === undefined
  ? input.text
  : `[novakai context] ${JSON.stringify(input.screenContext)}\n${input.text}`;

/** Adapts the sole Agents contract to one completed provider CLI turn. */
export function createAgentsProviderSend(agents: AgentsSendDoor): ProviderSend {
  return {
    async dispatch(input): Promise<ProviderDispatchResult> {
      const dispatchedAt = new Date().toISOString();
      const outcome = object(await agents.executeProviderTurn({
        agentId: input.targetAgentId,
        text: providerInput(input),
        ...(input.resumeId === undefined ? {} : { resumeId: input.resumeId }),
      } as never));
      const error = object(outcome?.error);
      const value = object(outcome?.value);
      return outcome?.ok === true
        ? {
            ok: true,
            dispatchedAt,
            certainty: 'unconfirmed',
            response: typeof value?.response === 'string' ? value.response : '',
          }
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
