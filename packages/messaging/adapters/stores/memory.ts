import type {
  AcceptSendInput,
  AcceptSendResult,
  SendTransitionInput,
  SendTransitionResult,
  TranscriptBatchInput,
  TranscriptBatchResult,
  TranscriptEvent,
  TranscriptLineQuery,
  TranscriptStore,
} from "../../contract/ports/transcript-store.js";
import type { IngestCheckpoint } from "../../contract/records/ingest-checkpoint.js";
import type { ProviderSession } from "../../contract/records/provider-session.js";
import type { TranscriptLine } from "../../contract/records/transcript-line.js";
import type { EventCursor, TranscriptSourceId } from "../../contract/types.js";
import type { SendJournal } from "../../contract/records/send-journal.js";
import type { ProviderSessionId } from "../../contract/types.js";
import { SendJournalState } from "./send-journal-state.js";
import { PendingDeliveryState } from './pending-delivery-state.js';
import { TranscriptState } from "./transcript-state.js";
import { ConversationViewState } from './conversation-view-state.js';
import { ProjectionState } from './projection-state.js';

/** Creates a contract-faithful volatile TranscriptStore for tests and embeds. */
export function createMemoryTranscriptStore(): TranscriptStore {
  const state = new TranscriptState();
  const sends = new SendJournalState();
  const deliveries = new PendingDeliveryState();
  const conversations = new ConversationViewState();
  const projections = new ProjectionState();
  return {
    getCheckpoint: async (sourceId: TranscriptSourceId): Promise<IngestCheckpoint | null> =>
      state.getCheckpoint(sourceId),
    upsertProviderSession: async (session: ProviderSession): Promise<ProviderSession> =>
      state.upsertSession(session),
    commitIngestBatch: (input: TranscriptBatchInput): Promise<TranscriptBatchResult> =>
      state.commit(input),
    listProviderSessions: async (): Promise<readonly ProviderSession[]> =>
      state.listProviderSessions(),
    listTranscriptLines: async (query?: TranscriptLineQuery): Promise<readonly TranscriptLine[]> =>
      state.listTranscriptLines(query),
    getTranscriptLine: async (id) => state.getTranscriptLine(id),
    acceptSend: (input: AcceptSendInput): Promise<AcceptSendResult> => sends.accept(input.journal),
    transitionSend: (input: SendTransitionInput): Promise<SendTransitionResult> =>
      sends.transition(input),
    bindAgentSession: (agentId, sessionId, updatedAt) =>
      sends.bindAgentSession(agentId, sessionId, updatedAt),
    confirmSendForLines: (sessionId, lines, updatedAt) =>
      sends.confirmForLines(sessionId, lines, updatedAt),
    listSendJournals: async (): Promise<readonly SendJournal[]> => sends.list(),
    acceptPendingDelivery: (input) => deliveries.accept(input.delivery),
    transitionPendingDelivery: (input) => deliveries.transition(input),
    listPendingDeliveries: async () => deliveries.list(),
    setConversationView: (input) => conversations.setView(input, async () => undefined),
    getConversationView: async (id) => conversations.getView(id),
    listConversationViews: async () => conversations.list(),
    replaceProjections: (result) => projections.replace(result, async () => undefined),
    readProjections: async () => projections.read(),
    scanTranscriptEvents: async (after?: EventCursor, limit?: number): Promise<readonly TranscriptEvent[]> =>
      state.scanEvents(after, limit),
    close: async () => undefined,
  };
}
