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

/** The complete host send: durable acceptance, one claimed effect, transcript wait. */
export async function sendConversationMessage(
  dependencies: SendDependencies,
  input: ConversationSendInput,
): Promise<ConversationSendAcceptance> {
  const accepted = await acceptSend(dependencies, input);
  const journal = await dispatchAcceptedSend(dependencies, accepted.journal);
  return {
    sendId: journal.id,
    clientOpId: journal.clientOpId,
    state: journal.state,
    duplicate: accepted.duplicate,
    targetAgentId: journal.targetAgentId,
    ...(journal.targetSessionId === undefined
      ? {} : { targetSessionId: journal.targetSessionId }),
  };
}
