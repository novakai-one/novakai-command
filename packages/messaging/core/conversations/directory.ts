import { createHash } from 'node:crypto';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { Timestamp } from '../../contract/types.js';
import { ensureConversationView, type ConversationViewStore } from './views.js';

/**
 * Implements the ConversationDirectory seam against the transcript store, for
 * hosts that have no conversation store of their own. An adopted external
 * agent gets a human↔agent conversation titled after its provider session;
 * an agent-to-agent delivery gets an archived "Agent communication" view.
 * Conversation ids are derived deterministically from the participants, so
 * repeat calls converge on the same view instead of minting duplicates.
 */
export function createStoredConversationDirectory(options: {
  readonly store: ConversationViewStore;
  readonly humanPrincipalId: string;
  readonly now: () => Timestamp;
}): ConversationDirectory {
  return {
    async ensureForAdoptedAgent(input) {
      const conversationId = `conv_external_${digest(input.agent.agentId)}`;
      await ensureConversationView(options.store, {
        conversationId,
        participantIds: [options.humanPrincipalId, input.agent.agentId],
        clientOpId: input.clientOpId,
        titleOverride: providerTitle(input.agent.provider, input.resumeId),
        address: `agent:${input.agent.agentId}`,
        agentId: input.agent.agentId,
        provider: input.agent.provider,
      }, options.now);
      return { conversationId };
    },

    async ensureForAgentPair(input) {
      const participants = [...input.participantAgentIds].sort();
      const conversationId = `conv_agents_${digest(participants.join(':'))}`;
      await ensureConversationView(options.store, {
        conversationId,
        participantIds: participants,
        clientOpId: input.clientOpId,
        titleOverride: 'Agent communication',
        archived: true,
      }, options.now);
      return { conversationId };
    },
  };
}

/** Stable short id fragment, so participant sets map to one durable id. */
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

/** "External Claude …ab12cd34" — or "…session" when the provider gave no resume id. */
const providerTitle = (provider: string, resumeId?: string): string =>
  `External ${provider.charAt(0).toUpperCase()}${provider.slice(1)} ${resumeId?.slice(-8) ?? 'session'}`;
