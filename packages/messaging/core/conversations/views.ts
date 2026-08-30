import type {
  EnsureConversationViewInput,
  UpdateConversationViewInput,
} from '../../contract/conversations.js';
import type {
  ConversationView,
  ConversationViewMutation,
} from '../../contract/records/conversation-view.js';
import { parseConversationId } from '../../contract/conversation-id.js';
import { parseTranscriptLineId } from '../../contract/transcript-line-id.js';
import {
  MessagingError,
  type ConversationId,
  type Timestamp,
  type TranscriptLineId,
} from '../../contract/types.js';
import { present } from '../sparse.js';

/**
 * Hosts supply activity timestamps as plain strings; the brand has no pattern
 * to parse against, so this one seam is the single place a host string becomes
 * a `Timestamp` — the same role the ID parsers play for branded IDs.
 */
const hostTimestamp = (value: Timestamp | string | undefined): Timestamp | undefined =>
  value === undefined ? undefined : (value as Timestamp);

/** The two view operations conversations need — nothing else. */
export interface ConversationViewStore {
  getConversationView(id: string): Promise<ConversationView | null>;
  setConversationView(input: ConversationViewMutation): Promise<ConversationView>;
}

/** The invariant a rejected view write names, so hosts branch instead of parsing prose. */
type ConversationViewRule =
  | 'malformed-id'
  | 'invalid-participants'
  | 'participants-immutable'
  | 'unknown-conversation'
  | 'invalid-last-read-line';

/**
 * Creates the host-facing view of one conversation, or applies new
 * presentation fields to the existing one. One call covers both cases so
 * every writer is idempotent: repeating an already-applied input returns the
 * current view unchanged. The conversation id and its participants are fixed
 * at creation — rebinding an existing view to different people is rejected,
 * because the view is the host's durable join onto transcript history.
 *
 * Every rejection is a typed, non-retryable `InvalidConversationView`; the
 * runtime door passes it through unchanged.
 */
export async function ensureConversationView(
  store: ConversationViewStore,
  input: EnsureConversationViewInput,
  clock: () => Timestamp,
): Promise<ConversationView> {
  const conversationId = requireConversationId(input.conversationId);
  const participants = requireParticipants(input.conversationId, input.participantIds);
  const lastReadLineId = requireLastReadLineId(input.conversationId, input.lastReadLineId);
  const current = await store.getConversationView(input.conversationId);
  if (current === null) {
    return store.setConversationView({
      view: createdView(conversationId, participants, input, lastReadLineId, clock()),
      clientOpId: input.clientOpId,
    });
  }
  requireSameParticipants(input.conversationId, current, participants);
  if (alreadyApplied(current, input, lastReadLineId)) return current;
  return store.setConversationView({
    view: mergedView(current, input, lastReadLineId, clock()),
    clientOpId: input.clientOpId,
  });
}

/**
 * Applies new presentation fields to an existing conversation view. Only the
 * fields present in the input change; everything else carries over untouched.
 * Unknown conversations are rejected rather than created — creation goes
 * through `ensureConversationView`, which owns the immutable facts.
 *
 * Every rejection is a typed, non-retryable `InvalidConversationView`; the
 * runtime door passes it through unchanged.
 */
export async function updateConversationView(
  store: ConversationViewStore,
  input: UpdateConversationViewInput,
  clock: () => Timestamp,
): Promise<ConversationView> {
  requireConversationId(input.conversationId);
  const lastReadLineId = requireLastReadLineId(input.conversationId, input.lastReadLineId);
  const current = await store.getConversationView(input.conversationId);
  if (current === null) {
    throw invalidView(
      input.conversationId, 'unknown-conversation',
      `Unknown Conversation View ${input.conversationId}`,
    );
  }
  return store.setConversationView({
    view: {
      ...current,
      updatedAt: clock(),
      ...present('titleOverride', input.titleOverride),
      ...present('pinned', input.pinned),
      ...present('archived', input.archived),
      ...present('lastActivityAt', hostTimestamp(input.lastActivityAt)),
      ...present('lastReadLineId', lastReadLineId),
    },
    clientOpId: input.clientOpId,
  });
}

/** The view at creation: immutable facts from the input, timestamps from the clock. */
const createdView = (
  conversationId: ConversationId,
  participants: readonly string[],
  input: EnsureConversationViewInput,
  lastReadLineId: TranscriptLineId | undefined,
  timestamp: Timestamp,
): ConversationView => ({
  id: conversationId,
  kind: 'conversation-view',
  schemaVersion: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  participantIds: participants,
  pinned: input.pinned ?? false,
  archived: input.archived ?? false,
  lastActivityAt: hostTimestamp(input.lastActivityAt) ?? timestamp,
  ...present('titleOverride', input.titleOverride),
  ...present('lastReadLineId', lastReadLineId),
  ...present('address', input.address),
  ...present('agentId', input.agentId),
  ...present('provider', input.provider),
});

/** The stored view with the input's supplied fields carried over it. */
const mergedView = (
  current: ConversationView,
  input: EnsureConversationViewInput,
  lastReadLineId: TranscriptLineId | undefined,
  timestamp: Timestamp,
): ConversationView => ({
  ...current,
  updatedAt: timestamp,
  pinned: input.pinned ?? current.pinned,
  archived: input.archived ?? current.archived,
  lastActivityAt: hostTimestamp(input.lastActivityAt) ?? current.lastActivityAt,
  ...present('titleOverride', carried(input.titleOverride, current.titleOverride)),
  ...present('lastReadLineId', carried(lastReadLineId, current.lastReadLineId)),
  ...present('address', carried(input.address, current.address)),
  ...present('agentId', carried(input.agentId, current.agentId)),
  ...present('provider', carried(input.provider, current.provider)),
});

/** The merge rule for every mutable field: the incoming value when supplied, else the stored one. */
const carried = <Value>(incoming: Value | undefined, stored: Value | undefined): Value | undefined =>
  incoming ?? stored;

/** True when every field the input declares already matches the stored view. */
function alreadyApplied(
  current: ConversationView,
  input: EnsureConversationViewInput,
  lastReadLineId: TranscriptLineId | undefined,
): boolean {
  const declared: ReadonlyArray<readonly [unknown, unknown]> = [
    [input.titleOverride, current.titleOverride],
    [input.pinned, current.pinned],
    [input.archived, current.archived],
    [input.lastActivityAt, current.lastActivityAt],
    [lastReadLineId, current.lastReadLineId],
    [input.address, current.address],
    [input.agentId, current.agentId],
    [input.provider, current.provider],
  ];
  return declared.every(([incoming, stored]) => incoming === undefined || incoming === stored);
}

const invalidView = (
  conversationId: string,
  rule: ConversationViewRule,
  message: string,
): MessagingError =>
  new MessagingError('InvalidConversationView', { message, fields: { conversationId, rule } });

/** A conversation id must parse against the contract's branded pattern. */
const requireConversationId = (value: string): ConversationId => {
  const parsed = parseConversationId(value);
  if (parsed !== undefined) return parsed;
  throw invalidView(value, 'malformed-id', 'Conversation View requires a valid ID');
};

/** Participant lists must be unique and non-empty to be a durable join key. */
const requireParticipants = (
  conversationId: string,
  participants: readonly string[],
): readonly string[] => {
  const normalized = [...new Set(participants.filter((value) => value.trim() !== ''))];
  if (normalized.length > 0 && normalized.length === participants.length) return normalized;
  throw invalidView(
    conversationId, 'invalid-participants',
    'Conversation View requires unique, non-empty participant IDs',
  );
};

/** The participants fixed at creation may never be rebound; order is not identity. */
const requireSameParticipants = (
  conversationId: string,
  current: ConversationView,
  participants: readonly string[],
): void => {
  const same = [...current.participantIds].sort().join(' ')
    === [...participants].sort().join(' ');
  if (same) return;
  throw invalidView(
    conversationId, 'participants-immutable',
    `Conversation View ${conversationId} participants cannot change`,
  );
};

/** A supplied lastReadLineId must parse as a Transcript Line ID; absent stays absent. */
const requireLastReadLineId = (
  conversationId: string,
  value: TranscriptLineId | string | undefined,
): TranscriptLineId | undefined => {
  if (value === undefined) return undefined;
  const parsed = parseTranscriptLineId(value);
  if (parsed !== undefined) return parsed;
  throw invalidView(
    conversationId, 'invalid-last-read-line',
    'Conversation View lastReadLineId must be a Transcript Line ID',
  );
};
