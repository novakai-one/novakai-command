import type {
  ConversationId,
  ProviderName,
  Timestamp,
  TranscriptLineId,
} from './types.js';

/** Provider-neutral query for one Agent's canonical conversation stream. */
export interface AgentConversationMessagesQuery {
  readonly agentId: string;
}

/** One human-visible message after provider-specific transcript interpretation. */
export interface AgentConversationMessage {
  readonly id: TranscriptLineId;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly occurredAt: Timestamp | string;
  readonly clientOpId?: string;
}

/** Trusted get-or-create input; participants are immutable after creation. */
export interface EnsureConversationViewInput {
  readonly conversationId: ConversationId | string;
  readonly participantIds: readonly string[];
  readonly clientOpId: string;
  readonly titleOverride?: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly lastActivityAt?: string;
  readonly lastReadLineId?: TranscriptLineId | string;
  readonly address?: string;
  readonly agentId?: string;
  readonly provider?: ProviderName | 'mock';
}

/** Mutable presentation fields; omitted fields remain unchanged. */
export interface UpdateConversationViewInput {
  readonly conversationId: ConversationId | string;
  readonly clientOpId: string;
  readonly titleOverride?: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly lastActivityAt?: string;
  readonly lastReadLineId?: TranscriptLineId | string;
}
