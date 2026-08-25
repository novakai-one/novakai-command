import type {
  ConversationId,
  ProviderSessionId,
  SendAttemptId,
  SendAttemptState,
  SendId,
  SendState,
  Timestamp,
  TranscriptLineId,
} from '../types.js';

/** Immutable request captured before a provider effect starts. */
export interface AcceptedSendRequest {
  readonly text: string;
  readonly screenContext?: Readonly<Record<string, unknown>>;
}

/** One provider effect and its transcript-derived outcome. */
export interface SendAttempt {
  readonly attemptId: SendAttemptId;
  readonly state: SendAttemptState;
  readonly dispatchedAt: Timestamp;
  readonly confirmedLineId?: TranscriptLineId;
  readonly failure?: string;
}

/** Durable lifecycle of one accepted conversation send. */
export interface SendJournal {
  readonly id: SendId;
  readonly kind: 'send-journal';
  readonly schemaVersion: 1;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly conversationId: ConversationId;
  readonly issuedBy: string;
  readonly targetAgentId: string;
  readonly targetSessionId?: ProviderSessionId;
  readonly clientOpId: string;
  readonly request: AcceptedSendRequest;
  readonly requestHash: string;
  readonly state: SendState;
  readonly attempts: readonly SendAttempt[];
}
