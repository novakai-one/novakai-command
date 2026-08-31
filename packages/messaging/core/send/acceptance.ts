import type { ConversationSendAcceptance } from '../../contract/commands.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import { present } from '../sparse.js';

/**
 * Shapes the public acceptance from the journaled outcome. One builder owns
 * the field-by-field assembly so the entry point reads as orchestration, not
 * DTO plumbing.
 */
export function buildSendAcceptance(input: {
  readonly journal: SendJournal;
  readonly duplicate: boolean;
  readonly response?: string;
}): ConversationSendAcceptance {
  const { journal } = input;
  return {
    sendId: journal.id,
    clientOpId: journal.clientOpId,
    state: journal.state,
    duplicate: input.duplicate,
    targetAgentId: journal.targetAgentId,
    ...present('targetSessionId', journal.targetSessionId),
    ...present('response', input.response),
  };
}
