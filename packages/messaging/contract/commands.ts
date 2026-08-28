/** Transcript-first send command declarations. */
import type { SendJournal } from './records/send-journal.js';

/** Trusted host command; the host derives issuedBy from its authenticated holder. */
export interface ConversationSendInput {
  readonly conversationId: string;
  readonly issuedBy: string;
  readonly targetAgentId: string;
  readonly text: string;
  readonly clientOpId: string;
  readonly screenContext?: Readonly<Record<string, unknown>>;
}

/** Transcript-first acceptance, with synchronous provider text when this call executed the turn. */
export interface ConversationSendAcceptance {
  readonly sendId: SendJournal['id'];
  readonly clientOpId: string;
  readonly state: SendJournal['state'];
  readonly duplicate: boolean;
  readonly targetAgentId: string;
  readonly targetSessionId?: SendJournal['targetSessionId'];
  readonly response?: string;
}
