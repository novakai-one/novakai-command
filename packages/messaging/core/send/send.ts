import type {
  ConversationSendAcceptance,
  ConversationSendInput,
} from '../../contract/commands.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import { acceptSend } from './accept.js';
import { dispatchAcceptedSend } from './dispatch.js';

interface SendDependencies {
  readonly store: TranscriptStore;
  readonly providerSend: ProviderSend;
  readonly agentDirectory: AgentDirectory;
  readonly now: () => string;
}

/**
 * Sends one conversation message end to end: validate and journal the
 * request, hand it to the provider exactly once, then report the state the
 * send now waits in. This is the single entry point for sending, so every
 * send gets idempotent journaling and one-shot dispatch without callers
 * coordinating the steps themselves.
 */
export async function sendConversationMessage(
  dependencies: SendDependencies,
  input: ConversationSendInput,
): Promise<ConversationSendAcceptance> {
  const accepted = await acceptSend(dependencies, input);
  const dispatched = await dispatchAcceptedSend(dependencies, accepted.journal);
  const journal = dispatched.journal;
  return {
    sendId: journal.id,
    clientOpId: journal.clientOpId,
    state: journal.state,
    duplicate: accepted.duplicate,
    targetAgentId: journal.targetAgentId,
    ...(journal.targetSessionId === undefined
      ? {} : { targetSessionId: journal.targetSessionId }),
    ...(dispatched.response === undefined ? {} : { response: dispatched.response }),
  };
}
