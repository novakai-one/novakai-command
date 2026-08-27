/** Load durable Conversation Views into the Server's in-memory index. */

import { createHash } from 'node:crypto';
import { listConversationViews } from '../../../shell/contract/conversationView.js';
import type { MessagingRuntimeApi } from '../../../messaging/contract/index.js';
import type { Conversation } from '../methods.js';

type ConversationViewDriver = Parameters<typeof listConversationViews>[0];

const migrationOpId = (view: object): string =>
  `migration:conversation-view:${'id' in view ? String(view.id) : 'unknown'}:${createHash('sha256')
    .update(JSON.stringify(view), 'utf8').digest('hex').slice(0, 16)}`;

export async function hydrateConversations(
  driver: ConversationViewDriver,
  messaging: Pick<MessagingRuntimeApi, 'ensureConversationView' | 'listConversationViews'>,
  humanPrincipalId: string,
): Promise<{
  conversations: Map<string, Conversation>;
  views: Awaited<ReturnType<typeof listConversationViews>>;
}> {
  const views = await listConversationViews(driver);
  for (const view of views) {
    const participant = view.agentId ?? view.address?.replace(/^person:/u, '') ?? view.id;
    const imported = await messaging.ensureConversationView({
      conversationId: view.id,
      participantIds: [humanPrincipalId, participant],
      clientOpId: migrationOpId(view),
      pinned: view.pinned,
      archived: view.archived,
      lastActivityAt: view.lastActivityAt,
      ...(view.titleOverride === undefined ? {} : { titleOverride: view.titleOverride }),
      ...(view.lastReadMessageId === undefined ? {} : { lastReadLineId: view.lastReadMessageId }),
      ...(view.address === undefined ? {} : { address: view.address }),
      ...(view.agentId === undefined ? {} : { agentId: view.agentId }),
      ...(view.provider === undefined ? {} : { provider: view.provider }),
    });
    if (imported.kind === 'error') {
      throw new Error(`Conversation View import failed: ${imported.error.message}`);
    }
  }
  const target = await messaging.listConversationViews();
  if (target.kind === 'error') {
    throw new Error(`Conversation View hydration failed: ${target.error.message}`);
  }
  const conversations = new Map<string, Conversation>();
  for (const view of target.value) {
    conversations.set(view.id, {
      id: view.id,
      address: view.address ?? (view.agentId === undefined ? '' : `agent:${view.agentId}`),
      title: view.titleOverride ?? view.id,
      kind: view.agentId === undefined ? 'direct' : 'agent',
      pinned: view.pinned,
      archived: view.archived,
      lastActivityAt: view.lastActivityAt,
      ...(view.agentId ? { agentId: view.agentId } : {}),
      ...(view.provider ? { provider: view.provider } : {}),
      ...(view.lastReadLineId ? { lastReadMessageId: view.lastReadLineId } : {}),
    });
  }
  return { conversations, views };
}
