import type {
  EnsureConversationViewInput,
  UpdateConversationViewInput,
} from '../../contract/conversations.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { ConversationView } from '../../contract/records/conversation-view.js';
import type { ConversationId, Timestamp, TranscriptLineId } from '../../contract/types.js';

const validId = (id: string): boolean => /^conv_[A-Za-z0-9-]+$/u.test(id);

function alreadyApplied(current: ConversationView, input: EnsureConversationViewInput): boolean {
  return (input.titleOverride === undefined || input.titleOverride === current.titleOverride)
    && (input.pinned === undefined || input.pinned === current.pinned)
    && (input.archived === undefined || input.archived === current.archived)
    && (input.lastActivityAt === undefined || input.lastActivityAt === current.lastActivityAt)
    && (input.lastReadLineId === undefined || input.lastReadLineId === current.lastReadLineId)
    && (input.address === undefined || input.address === current.address)
    && (input.agentId === undefined || input.agentId === current.agentId)
    && (input.provider === undefined || input.provider === current.provider);
}

function validateParticipants(participants: readonly string[]): readonly string[] {
  const normalized = [...new Set(participants.filter((value) => value.trim() !== ''))];
  if (normalized.length === 0 || normalized.length !== participants.length) {
    throw new Error('Conversation View requires unique, non-empty participant IDs');
  }
  return normalized;
}

/** Idempotently creates a durable View, or updates presentation state without rebinding it. */
export async function ensureConversationView(
  store: TranscriptStore,
  input: EnsureConversationViewInput,
  now: () => string,
): Promise<ConversationView> {
  if (!validId(input.conversationId)) throw new Error('Conversation View requires a valid ID');
  const participants = validateParticipants(input.participantIds);
  const current = await store.getConversationView(input.conversationId);
  if (current !== null
    && JSON.stringify(current.participantIds) !== JSON.stringify(participants)) {
    throw new Error(`Conversation View ${input.conversationId} participants cannot change`);
  }
  if (current !== null && alreadyApplied(current, input)) return current;
  const timestamp = now() as Timestamp;
  const view: ConversationView = {
    id: input.conversationId as ConversationId,
    kind: 'conversation-view',
    schemaVersion: 1,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
    participantIds: current?.participantIds ?? participants,
    pinned: input.pinned ?? current?.pinned ?? false,
    archived: input.archived ?? current?.archived ?? false,
    lastActivityAt: input.lastActivityAt ?? current?.lastActivityAt ?? timestamp,
    ...(input.titleOverride ?? current?.titleOverride
      ? { titleOverride: input.titleOverride ?? current!.titleOverride } : {}),
    ...(input.lastReadLineId ?? current?.lastReadLineId
      ? { lastReadLineId: (input.lastReadLineId ?? current!.lastReadLineId) as TranscriptLineId } : {}),
    ...(input.address ?? current?.address ? { address: input.address ?? current!.address } : {}),
    ...(input.agentId ?? current?.agentId ? { agentId: input.agentId ?? current!.agentId } : {}),
    ...(input.provider ?? current?.provider ? { provider: input.provider ?? current!.provider } : {}),
  };
  return store.setConversationView({ view, clientOpId: input.clientOpId });
}

/** Replaces only declared mutable fields on an existing View. */
export async function updateConversationView(
  store: TranscriptStore,
  input: UpdateConversationViewInput,
  now: () => string,
): Promise<ConversationView> {
  const current = await store.getConversationView(input.conversationId);
  if (current === null) throw new Error(`Unknown Conversation View ${input.conversationId}`);
  const view: ConversationView = {
    ...current,
    updatedAt: now() as Timestamp,
    ...(input.titleOverride === undefined ? {} : { titleOverride: input.titleOverride }),
    ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
    ...(input.lastActivityAt === undefined ? {} : { lastActivityAt: input.lastActivityAt }),
    ...(input.lastReadLineId === undefined
      ? {} : { lastReadLineId: input.lastReadLineId as TranscriptLineId }),
  };
  return store.setConversationView({ view, clientOpId: input.clientOpId });
}
