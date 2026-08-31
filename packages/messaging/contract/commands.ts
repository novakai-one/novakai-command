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

/**
 * Why a send was rejected before any durable write. Expected failures are
 * values, not exceptions: hosts branch on `code` instead of parsing error
 * message strings.
 */
export type SendRejection =
  | {
      readonly code: 'invalid-send-input';
      readonly field: 'conversationId' | 'issuedBy' | 'targetAgentId' | 'clientOpId' | 'text';
      readonly message: string;
    }
  | {
      readonly code: 'unknown-target-agent';
      readonly targetAgentId: string;
      readonly message: string;
    };

/**
 * Result of one send: journaled acceptance, or a typed rejection raised
 * before the store or provider was touched.
 */
export type SendConversationResult =
  | { readonly ok: true; readonly acceptance: ConversationSendAcceptance }
  | { readonly ok: false; readonly rejection: SendRejection };
