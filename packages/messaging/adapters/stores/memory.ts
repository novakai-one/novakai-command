import type {
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
import { TranscriptState } from "./transcript-state.js";

/** Creates a contract-faithful volatile TranscriptStore for tests and embeds. */
export function createMemoryTranscriptStore(): TranscriptStore {
  const state = new TranscriptState();
  return {
    getCheckpoint: async (sourceId: TranscriptSourceId): Promise<IngestCheckpoint | null> =>
      state.getCheckpoint(sourceId),
    commitIngestBatch: (input: TranscriptBatchInput): Promise<TranscriptBatchResult> =>
      state.commit(input),
    listProviderSessions: async (): Promise<readonly ProviderSession[]> =>
      state.listProviderSessions(),
    listTranscriptLines: async (query?: TranscriptLineQuery): Promise<readonly TranscriptLine[]> =>
      state.listTranscriptLines(query),
    scanTranscriptEvents: async (after?: EventCursor, limit?: number): Promise<readonly TranscriptEvent[]> =>
      state.scanEvents(after, limit),
    close: async () => undefined,
  };
}
