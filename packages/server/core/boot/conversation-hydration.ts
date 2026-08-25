/** Load durable Conversation Views into the Server's in-memory index. */

import { listConversationViews } from '../../../shell/contract/conversationView.js';
import type { Conversation } from '../methods.js';

type ConversationViewDriver = Parameters<typeof listConversationViews>[0];

export async function hydrateConversations(
  driver: ConversationViewDriver,
): Promise<{
  conversations: Map<string, Conversation>;
  views: Awaited<ReturnType<typeof listConversationViews>>;
}> {
  const conversations = new Map<string, Conversation>();
  const views = await listConversationViews(driver);
  for (const view of views) {
    conversations.set(view.id, {
      id: view.id,
      address: view.threadRef?.kind === 'thread'
        ? `thread:${view.threadRef.id}`
        : (view.address ?? ''),
      title: view.titleOverride ?? view.id,
      kind: 'agent',
      pinned: view.pinned,
      archived: view.archived,
      lastActivityAt: view.lastActivityAt,
      ...(view.threadRef?.kind === 'thread' ? { threadId: view.threadRef.id } : {}),
      ...(view.agentId ? { agentId: view.agentId } : {}),
      ...(view.provider ? { provider: view.provider } : {}),
      ...(view.lastReadMessageId ? { lastReadMessageId: view.lastReadMessageId } : {}),
    });
  }
  return { conversations, views };
}
