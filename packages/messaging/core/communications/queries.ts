import { createHash } from 'node:crypto';
import { findAgentDeliveryMarker } from '../../contract/agent-delivery-marker.js';
import type {
  AgentCommunicationPage,
  AgentCommunicationsQuery,
  AgentCommunicationView,
} from '../../contract/communications.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';

const preview = (text: string): string => {
  const value = text.replace(/\s+/gu, ' ').trim();
  return value.length <= 160 ? value : `${value.slice(0, 159)}…`;
};

const fallbackThread = (participants: readonly string[]): string =>
  `thread_transcript-${createHash('sha256')
    .update([...participants].sort().join(':')).digest('hex').slice(0, 24)}`;

const direction = (
  senderAgentId: string | undefined,
  subjects: ReadonlySet<string>,
): AgentCommunicationView['direction'] => {
  if (senderAgentId === undefined) return 'to-agent';
  return subjects.has(senderAgentId) ? 'from-agent' : 'between-agents';
};

function journalView(
  journal: SendJournal,
  subjects: ReadonlySet<string>,
): AgentCommunicationView | undefined {
  const senderAgentId = journal.issuedBy.startsWith('agent_') ? journal.issuedBy : undefined;
  if (!subjects.has(journal.targetAgentId)
    && (senderAgentId === undefined || !subjects.has(senderAgentId))) return undefined;
  return {
    messageId: journal.id,
    threadId: journal.conversationId,
    conversationId: journal.conversationId,
    senderPrincipalId: journal.issuedBy,
    recipientAgentIds: [journal.targetAgentId],
    relatedRunIds: [],
    deliveryState: journal.state,
    occurredAt: journal.createdAt,
    direction: direction(senderAgentId, subjects),
    ...(senderAgentId === undefined ? {} : { senderAgentId }),
    textPreview: preview(journal.request.text),
    ...(journal.request.screenContext === undefined
      ? {} : { screenContext: journal.request.screenContext }),
  };
}

interface LineContext {
  readonly sessions: ReadonlyMap<string, ProviderSession>;
  readonly pending: ReadonlyMap<string, PendingDelivery>;
  readonly deliveryJournals: ReadonlyMap<string, SendJournal>;
  readonly confirmedLineIds: ReadonlySet<string>;
  readonly subjects: ReadonlySet<string>;
}

function addressedView(
  line: TranscriptLine,
  ownerAgentId: string,
  pending: PendingDelivery,
  journal: SendJournal | undefined,
  subjects: ReadonlySet<string>,
): AgentCommunicationView | undefined {
  const marker = findAgentDeliveryMarker(`${line.text}\n${line.raw}`);
  if (marker === undefined) return undefined;
  if (!subjects.has(ownerAgentId) && !subjects.has(marker.recipientAgentId)) return undefined;
  const conversationId = journal?.conversationId;
  return {
    messageId: line.id,
    threadId: marker.threadId ?? conversationId
      ?? fallbackThread([ownerAgentId, marker.recipientAgentId]),
    ...(conversationId === undefined ? {} : { conversationId }),
    senderPrincipalId: ownerAgentId,
    recipientAgentIds: [marker.recipientAgentId],
    relatedRunIds: [],
    deliveryState: pending.state,
    inboxState: pending.state,
    occurredAt: line.createdAt,
    direction: direction(ownerAgentId, subjects),
    senderAgentId: ownerAgentId,
    textPreview: preview(marker.text),
    ...(marker.screenContext === undefined ? {} : { screenContext: marker.screenContext }),
  };
}

function ordinaryLineView(
  line: TranscriptLine,
  ownerAgentId: string,
  subjects: ReadonlySet<string>,
): AgentCommunicationView | undefined {
  if (!subjects.has(ownerAgentId)) return undefined;
  if (line.role !== 'assistant' && line.role !== 'user') return undefined;
  const fromAgent = line.role === 'assistant';
  return {
    messageId: line.id,
    threadId: fallbackThread([ownerAgentId]),
    senderPrincipalId: fromAgent ? ownerAgentId : 'external-provider-user',
    recipientAgentIds: fromAgent ? [] : [ownerAgentId],
    relatedRunIds: [],
    deliveryState: 'transcript-observed',
    occurredAt: line.createdAt,
    direction: fromAgent ? 'from-agent' : 'to-agent',
    ...(fromAgent ? { senderAgentId: ownerAgentId } : {}),
    textPreview: preview(line.text),
  };
}

function lineView(line: TranscriptLine, context: LineContext): AgentCommunicationView | undefined {
  const ownerAgentId = context.sessions.get(line.sessionId)?.agentId;
  if (ownerAgentId === undefined) return undefined;
  const pending = context.pending.get(line.id);
  if (pending !== undefined) {
    return addressedView(
      line, ownerAgentId, pending,
      context.deliveryJournals.get(`delivery:${pending.id}`), context.subjects,
    );
  }
  if (context.confirmedLineIds.has(line.id)) return undefined;
  return ordinaryLineView(line, ownerAgentId, context.subjects);
}

/** Rebuilds the frozen Communications list from root records only. */
export async function listAgentCommunications(
  store: TranscriptStore,
  query: AgentCommunicationsQuery,
): Promise<AgentCommunicationPage> {
  if (query.agentIds.length === 0 || query.limit < 1 || query.limit > 200) {
    throw new Error('Communications query requires 1..N Agents and limit 1..200');
  }
  const [sessions, lines, pending, journals] = await Promise.all([
    store.listProviderSessions(), store.listTranscriptLines(),
    store.listPendingDeliveries(), store.listSendJournals(),
  ]);
  const context: LineContext = {
    sessions: new Map(sessions.map((item) => [item.id, item])),
    pending: new Map(pending.map((item) => [item.transcriptLineId, item])),
    deliveryJournals: new Map(journals.map((item) => [item.clientOpId, item])),
    confirmedLineIds: new Set(journals.flatMap((item) =>
      item.attempts.flatMap((attempt) => attempt.confirmedLineId === undefined
        ? [] : [attempt.confirmedLineId]))),
    subjects: new Set(query.agentIds),
  };
  const items = [
    ...journals.filter((item) => !item.clientOpId.startsWith('delivery:'))
      .map((item) => journalView(item, context.subjects)),
    ...lines.map((line) => lineView(line, context)),
  ].filter((item): item is AgentCommunicationView => item !== undefined)
    .filter((item) => query.threadId === undefined || item.threadId === query.threadId)
    .filter((item) => query.runIds === undefined
      || item.relatedRunIds.some((runId) => query.runIds!.includes(runId)))
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
      || left.messageId.localeCompare(right.messageId));
  const from = query.cursor === undefined
    ? 0 : Math.max(0, items.findIndex((item) => item.messageId === query.cursor) + 1);
  const page = items.slice(from, from + query.limit);
  const next = items[from + query.limit]?.messageId;
  return { items: page, ...(next === undefined ? {} : { nextCursor: page.at(-1)!.messageId }) };
}
