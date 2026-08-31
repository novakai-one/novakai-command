import type { ConversationId, ProviderName, Timestamp, TranscriptLineId } from '../types.js';

/** Durable participant and presentation state; content remains TranscriptLine-owned. */
export interface ConversationView {
  readonly id: ConversationId;
  readonly kind: 'conversation-view';
  readonly schemaVersion: 1;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly participantIds: readonly string[];
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly lastActivityAt: Timestamp;
  readonly titleOverride?: string;
  readonly lastReadLineId?: TranscriptLineId;
  readonly address?: string;
  readonly agentId?: string;
  readonly provider?: ProviderName | 'mock';
}

/** Idempotent full-state mutation used at the capability boundary. */
export interface ConversationViewMutation {
  readonly view: ConversationView;
  readonly clientOpId: string;
}
