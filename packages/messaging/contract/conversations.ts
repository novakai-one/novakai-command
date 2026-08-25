import type { ConversationId, ProviderName, TranscriptLineId } from './types.js';

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
