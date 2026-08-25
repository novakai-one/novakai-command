import {
  b3err,
  b3fail,
  b3ok,
  type AuthenticatedPrincipal,
  type B3Result,
  type CommandContext,
} from '@novakai/foundation/contract';
import {
  agentDeliveryMarker,
  type AgentDeliveryInstruction,
  type AgentMessagingContract,
  type MessageAcceptance,
  type SendAgentMessageInput,
} from '../../../messaging/contract/index.js';

interface AgentAddressedDeliveryOptions {
  readonly messaging: Pick<AgentMessagingContract, 'sendAgentMessage'>;
  readonly agentOfRun: (agentRunId: string) => Promise<string | null>;
}

const unknownIssuer = (): B3Result<never> => b3fail(b3err(
  'PermissionDenied',
  'an Agent Run may not send as an unknown Agent',
  { required: 'authenticated Agent Run' },
  false,
));

/** Emits provider-transcript evidence for Agent-to-Agent delivery. */
export async function sendAgentCommand(
  options: AgentAddressedDeliveryOptions,
  payload: SendAgentMessageInput,
  context: CommandContext,
  principal: AuthenticatedPrincipal,
): Promise<B3Result<MessageAcceptance | AgentDeliveryInstruction>> {
  if (principal.kind !== 'agent-run' || payload.target.kind !== 'agent') {
    return options.messaging.sendAgentMessage(context, payload);
  }
  if (await options.agentOfRun(principal.agentRunId ?? '') === null) return unknownIssuer();
  const clientOpId = String(context.clientOpId);
  return b3ok({
    kind: 'transcript-addressed-delivery',
    recipientAgentId: payload.target.agentId,
    clientOpId,
    transcriptMarker: agentDeliveryMarker({
      version: 1,
      recipientAgentId: payload.target.agentId,
      text: payload.text,
      clientOpId,
      ...(payload.threadId === undefined ? {} : { threadId: payload.threadId }),
      ...(payload.screenContext === undefined
        ? {} : { screenContext: { ...payload.screenContext } }),
    }),
  });
}
