import { idPatterns, type ConversationId } from './types.js';

const conversationIdPattern = new RegExp(idPatterns.ConversationId, 'u');

/** The single runtime parser for Conversation IDs accepted by the contract. */
export function parseConversationId(value: unknown): ConversationId | undefined {
  return typeof value === 'string' && conversationIdPattern.test(value)
    ? value as ConversationId
    : undefined;
}
