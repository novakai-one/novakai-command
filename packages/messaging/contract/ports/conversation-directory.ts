import type { AgentDirectoryEntry } from './agent-directory.js';

/** Minimum host-view facts required when an external session becomes visible. */
export interface EnsureAdoptedConversationInput {
  readonly agent: AgentDirectoryEntry;
  readonly sessionId: string;
  readonly resumeId?: string;
  readonly clientOpId: string;
}

/** Canonical direct View request for an Agent-to-Agent delivery. */
export interface EnsureAgentPairConversationInput {
  readonly participantAgentIds: readonly [string, string];
  readonly clientOpId: string;
}

/** Temporary host seam until TF-06 moves Conversation View into Messaging. */
export interface ConversationDirectory {
  ensureForAdoptedAgent(
    input: EnsureAdoptedConversationInput,
  ): Promise<{ readonly conversationId: string }>;
  ensureForAgentPair(
    input: EnsureAgentPairConversationInput,
  ): Promise<{ readonly conversationId: string }>;
}
