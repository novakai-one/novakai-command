import { createHash } from 'node:crypto';
import { findAgentDeliveryMarkerInLine } from '../delivery/delivery-marker-codec.js';
import { clientOpIdFor, isDeliveryClientOpId } from '../delivery/send-input.js';
import { present } from '../sparse.js';
import { compareStrings } from '../compare.js';
import { MessagingError } from '../../contract/types.js';
import type { TranscriptLineId } from '../../contract/types.js';
import type {
  AgentCommunicationPage,
  AgentCommunicationsQuery,
  AgentCommunicationView,
} from '../../contract/communications.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';

/** The four committed lists the Communications page reads — nothing else. */
export interface CommunicationsReads {
  listProviderSessions(): Promise<readonly ProviderSession[]>;
  listTranscriptLines(): Promise<readonly TranscriptLine[]>;
  listPendingDeliveries(): Promise<readonly PendingDelivery[]>;
  listSendJournals(): Promise<readonly SendJournal[]>;
}

/**
 * Answers the Communications screen from root records alone: send journals
 * plus committed transcript lines. Nothing on this page is stored — the list
 * is re-derived on every call, so restart, replay, and rebuild all produce
 * the same rows.
 *
 * Rows come from two sources, merged and ordered by time:
 * 1. send journals — messages sent through Messaging, with their delivery
 *    state;
 * 2. transcript lines — everything observed on provider transcripts:
 *    agent-to-agent deliveries (carrying a delivery marker) and plain
 *    provider conversation lines.
 *
 * `conversationGroupingKey` is the conversation grouping key: the real
 * conversation id when the row belongs to one, otherwise a deterministic
 * stand-in derived from the row's participants (`fallbackConversationKey`).
 *
 * An impossible query is rejected as a typed, non-retryable `InvalidQuery`
 * before any read; retrying it would change nothing.
 */
export async function listAgentCommunications(
  store: CommunicationsReads,
  query: AgentCommunicationsQuery,
): Promise<AgentCommunicationPage> {
  requireValidQuery(query);
  const context = await loadLineContext(store, query.agentIds);
  const rows = collectRows(context).filter(inScope(query));
  return pageOf(rows, query);
}

/** Rejects an impossible query before any read; the door passes this through unchanged. */
function requireValidQuery(query: AgentCommunicationsQuery): void {
  if (query.agentIds.length > 0 && query.limit >= 1 && query.limit <= 200) return;
  throw new MessagingError('InvalidQuery', {
    message: 'Communications query requires 1..N Agents and limit 1..200',
    fields: { query: 'listAgentCommunications' },
  });
}

interface LineContext {
  readonly lines: readonly TranscriptLine[];
  readonly journals: readonly SendJournal[];
  readonly sessions: ReadonlyMap<string, ProviderSession>;
  readonly pending: ReadonlyMap<string, PendingDelivery>;
  readonly deliveryJournals: ReadonlyMap<string, SendJournal>;
  readonly confirmedLineIds: ReadonlySet<TranscriptLineId>;
  readonly subjects: ReadonlySet<string>;
}

/** The four record lists this page reads, indexed for the per-line joins. */
async function loadLineContext(
  store: CommunicationsReads,
  agentIds: readonly string[],
): Promise<LineContext> {
  const [sessions, lines, pending, journals] = await Promise.all([
    store.listProviderSessions(), store.listTranscriptLines(),
    store.listPendingDeliveries(), store.listSendJournals(),
  ]);
  const confirmedLineIds = new Set(
    journals.flatMap((journal) => journal.attempts
      .map((attempt) => attempt.confirmedLineId)
      .filter((lineId): lineId is TranscriptLineId => lineId !== undefined)),
  );
  return {
    lines,
    journals,
    sessions: new Map(sessions.map((item) => [item.id, item])),
    pending: new Map(pending.map((item) => [item.transcriptLineId, item])),
    deliveryJournals: new Map(journals.map((item) => [item.clientOpId, item])),
    confirmedLineIds,
    subjects: new Set(agentIds),
  };
}

/** Journal rows and line rows, merged and ordered by time; undefined rows are absent. */
function collectRows(context: LineContext): AgentCommunicationView[] {
  const journalRows = context.journals
    .filter((journal) => !isDeliveryClientOpId(journal.clientOpId))
    .map((journal) => journalRow(journal, context.subjects));
  const lineRows = context.lines.map((line) => lineRow(line, context));
  return [...journalRows, ...lineRows]
    .filter((item): item is AgentCommunicationView => item !== undefined)
    .sort(byOccurrence);
}

/** Occurrence order with a message-id tiebreak; code-unit order, so the page is identical on every host. */
const byOccurrence = (
  left: AgentCommunicationView,
  right: AgentCommunicationView,
): number =>
  compareStrings(left.occurredAt, right.occurredAt)
  || compareStrings(left.messageId, right.messageId);

/** The caller's grouping-key and run filters, resolved once, applied per row. */
const inScope = (query: AgentCommunicationsQuery) => {
  const runIds = query.runIds === undefined ? undefined : new Set(query.runIds);
  return (item: AgentCommunicationView): boolean =>
    (query.conversationGroupingKey === undefined
      || item.conversationGroupingKey === query.conversationGroupingKey)
    && (runIds === undefined || item.relatedRunIds.some((runId) => runIds.has(runId)));
};

/** One page of rows; `nextCursor` is present exactly when more rows follow. */
function pageOf(
  rows: readonly AgentCommunicationView[],
  query: AgentCommunicationsQuery,
): AgentCommunicationPage {
  const start = startIndex(rows, query.cursor);
  const items = rows.slice(start, start + query.limit);
  const last = items.at(-1);
  const moreFollow = rows.length > start + query.limit;
  return {
    items,
    ...present('nextCursor', moreFollow ? last?.messageId : undefined),
  };
}

/** Where the page starts: after the cursor row, or at the beginning. */
function startIndex(rows: readonly AgentCommunicationView[], cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const found = rows.findIndex((item) => item.messageId === cursor);
  return found < 0 ? 0 : found + 1;
}

/**
 * One row for a send the journal owns. The journal's conversation id is the
 * grouping key — these rows always belong to a real conversation.
 */
function journalRow(
  journal: SendJournal,
  subjects: ReadonlySet<string>,
): AgentCommunicationView | undefined {
  const senderAgentId = senderAgentIdOf(journal.issuedBy);
  if (!involvesSubject(journal, senderAgentId, subjects)) return undefined;
  return {
    messageId: journal.id,
    conversationGroupingKey: journal.conversationId,
    conversationId: journal.conversationId,
    senderPrincipalId: journal.issuedBy,
    recipientAgentIds: [journal.targetAgentId],
    relatedRunIds: [],
    deliveryState: journal.state,
    occurredAt: journal.createdAt,
    direction: direction(senderAgentId, subjects),
    ...present('senderAgentId', senderAgentId),
    textPreview: preview(journal.request.text),
    ...present('screenContext', journal.request.screenContext),
  };
}

/** The sending Agent's id when the sender is an Agent; undefined when it's you. */
const senderAgentIdOf = (issuedBy: string): string | undefined =>
  issuedBy.startsWith('agent_') ? issuedBy : undefined;

/** True when the send touches at least one of the queried Agents. */
const involvesSubject = (
  journal: SendJournal,
  senderAgentId: string | undefined,
  subjects: ReadonlySet<string>,
): boolean =>
  subjects.has(journal.targetAgentId)
  || (senderAgentId !== undefined && subjects.has(senderAgentId));

/**
 * Chooses which row, if any, one transcript line contributes: a delivery row
 * when a pending delivery claims the line, nothing when a send confirmation
 * already covers it, otherwise a plain provider conversation row.
 */
function lineRow(line: TranscriptLine, context: LineContext): AgentCommunicationView | undefined {
  const ownerAgentId = context.sessions.get(line.sessionId)?.agentId;
  if (ownerAgentId === undefined) return undefined;
  const pending = context.pending.get(line.id);
  if (pending !== undefined) return addressedLineRow(line, ownerAgentId, pending, context);
  if (context.confirmedLineIds.has(line.id)) return undefined;
  return plainLineRow(line, ownerAgentId, context.subjects);
}

/**
 * One row for a transcript line carrying an agent-to-agent delivery marker.
 * The grouping key is the delivery's conversation when one exists, otherwise
 * a deterministic stand-in for the participant pair.
 */
function addressedLineRow(
  line: TranscriptLine,
  ownerAgentId: string,
  pending: PendingDelivery,
  context: LineContext,
): AgentCommunicationView | undefined {
  const marker = findAgentDeliveryMarkerInLine(line);
  if (marker === undefined) return undefined;
  if (!context.subjects.has(ownerAgentId) && !context.subjects.has(marker.recipientAgentId)) {
    return undefined;
  }
  const conversationId = context.deliveryJournals.get(clientOpIdFor(pending))?.conversationId;
  return {
    messageId: line.id,
    conversationGroupingKey: conversationId
      ?? fallbackConversationKey([ownerAgentId, marker.recipientAgentId]),
    ...present('conversationId', conversationId),
    senderPrincipalId: ownerAgentId,
    recipientAgentIds: [marker.recipientAgentId],
    relatedRunIds: [],
    deliveryState: pending.state,
    inboxState: pending.state,
    occurredAt: line.createdAt,
    direction: direction(ownerAgentId, context.subjects),
    senderAgentId: ownerAgentId,
    textPreview: preview(marker.text),
    ...present('screenContext', marker.screenContext),
  };
}

/**
 * One row for a plain provider conversation line. No conversation exists for
 * these, so the grouping key is a deterministic stand-in derived from the
 * owning agent alone.
 */
function plainLineRow(
  line: TranscriptLine,
  ownerAgentId: string,
  subjects: ReadonlySet<string>,
): AgentCommunicationView | undefined {
  if (!subjects.has(ownerAgentId)) return undefined;
  if (line.role !== 'assistant' && line.role !== 'user') return undefined;
  const parties = observedParties(line.role, ownerAgentId);
  return {
    messageId: line.id,
    conversationGroupingKey: fallbackConversationKey([ownerAgentId]),
    senderPrincipalId: parties.senderPrincipalId,
    recipientAgentIds: parties.recipientAgentIds,
    relatedRunIds: [],
    deliveryState: 'transcript-observed',
    occurredAt: line.createdAt,
    direction: parties.direction,
    ...present('senderAgentId', parties.senderAgentId),
    textPreview: preview(line.text),
  };
}

interface ObservedParties {
  readonly direction: 'from-agent' | 'to-agent';
  readonly senderPrincipalId: string;
  readonly recipientAgentIds: readonly string[];
  readonly senderAgentId: string | undefined;
}

/** The two parties a plain provider line belongs to, told from the owning Agent's side. */
const observedParties = (role: 'assistant' | 'user', ownerAgentId: string): ObservedParties => {
  if (role === 'assistant') {
    return {
      direction: 'from-agent',
      senderPrincipalId: ownerAgentId,
      recipientAgentIds: [],
      senderAgentId: ownerAgentId,
    };
  }
  return {
    direction: 'to-agent',
    senderPrincipalId: 'external-provider-user',
    recipientAgentIds: [ownerAgentId],
    senderAgentId: undefined,
  };
};

/**
 * Deterministic grouping key for rows that belong to no conversation. Derived
 * from the sorted participants so every query run — and both sides of an
 * agent pair — lands on the same key. Never persisted; safe to change.
 */
const fallbackConversationKey = (participants: readonly string[]): string =>
  `conv_transcript-${createHash('sha256')
    .update([...participants].sort().join(':')).digest('hex').slice(0, 24)}`;

const preview = (text: string): string => {
  const value = text.replace(/\s+/gu, ' ').trim();
  return value.length <= 160 ? value : `${value.slice(0, 159)}…`;
};

const direction = (
  senderAgentId: string | undefined,
  subjects: ReadonlySet<string>,
): AgentCommunicationView['direction'] => {
  if (senderAgentId === undefined) return 'to-agent';
  return subjects.has(senderAgentId) ? 'from-agent' : 'between-agents';
};
