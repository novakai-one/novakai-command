/** Cursor-derived unread projection; no unread count is persisted. */

import type { ChatMessage, ConversationSummary } from '../../../contract/index.js';
import type { ObjectRecord } from '../../messages-designs/contract';
import { SELF_ID } from './records.js';

export function unreadMessages(
  conversation: ConversationSummary,
  loaded: readonly ChatMessage[],
): ChatMessage[] {
  const cutoff = conversation.lastReadMessageId
    ? loaded.findIndex((message) => message.id === conversation.lastReadMessageId)
    : -1;
  return loaded.slice(cutoff + 1)
    .filter((message) => message.senderId !== SELF_ID && !message.pending && !message.failed);
}

export function unreadNotificationRecords(
  conversation: ConversationSummary,
  loaded: readonly ChatMessage[],
): ObjectRecord[] {
  return unreadMessages(conversation, loaded).map((message) => ({
    id: `notif_unread_${message.id}`,
    kind: 'notification',
    title: message.text,
    createdAt: message.createdAt,
    fields: { status: 'unread', messageId: message.id },
    refs: [{ kind: 'thread', value: conversation.id }],
  }));
}
