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
import { TranscriptState } from "./transcript-state.js";

/** Creates a contract-faithful volatile TranscriptStore for tests and embeds. */
export function createMemoryTranscriptStore(): TranscriptStore {
  const state = new TranscriptState();
  const sends = new SendJournalState();
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
    acceptSend: (input: AcceptSendInput): Promise<AcceptSendResult> => sends.accept(input.journal),
    transitionSend: (input: SendTransitionInput): Promise<SendTransitionResult> =>
      sends.transition(input),
    bindAgentSession: (agentId, sessionId, updatedAt) =>
      sends.bindAgentSession(agentId, sessionId as ProviderSessionId, updatedAt),
    confirmSendForLines: (sessionId, lines, updatedAt) =>
      sends.confirmForLines(sessionId, lines, updatedAt),
    listSendJournals: async (): Promise<readonly SendJournal[]> => sends.list(),
    scanTranscriptEvents: async (after?: EventCursor, limit?: number): Promise<readonly TranscriptEvent[]> =>
      state.scanEvents(after, limit),
    close: async () => undefined,
  };
}
