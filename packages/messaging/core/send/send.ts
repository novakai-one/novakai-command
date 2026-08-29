import type {
  ConversationSendInput,
  SendConversationResult,
} from '../../contract/commands.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { Timestamp } from '../../contract/types.js';
import { acceptSend } from './accept.js';
import { buildSendAcceptance } from './acceptance.js';
import type { AgentLookup } from './agent-lookup.js';
import { dispatchAcceptedSend } from './dispatch.js';
import { present } from './sparse.js';
import type { SendStore } from './send-store.js';

interface SendDependencies {
  readonly store: SendStore;
  readonly providerSend: ProviderSend;
  readonly agentDirectory: AgentLookup;
  readonly now: () => Timestamp;
}

/**
 * Sends one conversation message end to end: validate and journal the
 * request, hand it to the provider exactly once, then report the state the
 * send now waits in. This is the single entry point for sending, so every
 * send gets idempotent journaling and one-shot dispatch without callers
 * coordinating the steps themselves.
 *
 * Expected failures — invalid input, an unknown target Agent — come back as
 * a typed rejection and nothing is written. Store and provider failures
 * throw; the runtime door maps them to a retryable DependencyUnavailable
 * outcome.
 *
 * Crash recovery: a journal written by acceptSend but never dispatched stays
 * in `accepted`, and no component re-dispatches it today — redrive is the
 * caller's responsibility (retry with the same clientOpId and the stored
 * journal comes back). Journals that did dispatch are confirmed from
 * transcript evidence by confirmPendingSends, which ingestion runs after
 * every pass.
 */
export async function sendConversationMessage(
  dependencies: SendDependencies,
  input: ConversationSendInput,
): Promise<SendConversationResult> {
  const accepted = await acceptSend(dependencies, input);
  if (!accepted.ok) return accepted;
  const dispatched = await dispatchAcceptedSend(dependencies, accepted.journal);
  if (!dispatched.ok) return dispatched;
  return {
    ok: true,
    acceptance: buildSendAcceptance({
      journal: dispatched.journal,
      duplicate: accepted.duplicate,
      ...present('response', dispatched.response),
    }),
  };
}
