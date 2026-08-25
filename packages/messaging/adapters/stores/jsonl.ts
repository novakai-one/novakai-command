import {
  composeHandle,
  type ScopedStoreHandle,
} from '@novakai/foundation/contract';
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
} from '../../contract/ports/transcript-store.js';
import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type {
  EventCursor,
  ProviderSessionId,
  TranscriptSourceId,
} from '../../contract/types.js';
import { restoreFoundationMessagingStore } from './foundation-replay.js';
import type { RestoredFoundationMessagingStore } from './foundation-replay.js';
import { FoundationMessagingWriter } from './foundation-writer.js';

/** Canonical Foundation-store location and lock policy for transcript-first Messaging. */
export interface FoundationTranscriptStoreOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly lockTimeoutMs?: number;
}

function storeFacade(
  restored: RestoredFoundationMessagingStore,
  writer: FoundationMessagingWriter,
): TranscriptStore {
  const { transcripts, sends, deliveries, conversations, projections } = restored;
  return {
    getCheckpoint: async (sourceId: TranscriptSourceId): Promise<IngestCheckpoint | null> =>
      transcripts.getCheckpoint(sourceId),
    upsertProviderSession: (session) =>
      transcripts.upsertSession(session, (value) => writer.persistSession(value)),
    commitIngestBatch: (input: TranscriptBatchInput): Promise<TranscriptBatchResult> =>
      transcripts.commit(input, (batch) => writer.persistTranscript(batch)),
    listProviderSessions: async (): Promise<readonly ProviderSession[]> =>
      transcripts.listProviderSessions(),
    listTranscriptLines: async (query?: TranscriptLineQuery): Promise<readonly TranscriptLine[]> =>
      transcripts.listTranscriptLines(query),
    acceptSend: (input: AcceptSendInput): Promise<AcceptSendResult> =>
      sends.accept(input.journal, (journals) => writer.persistSends(journals)),
    transitionSend: (input: SendTransitionInput): Promise<SendTransitionResult> =>
      sends.transition(input, (journals) => writer.persistSends(journals)),
    bindAgentSession: (agentId, sessionId, updatedAt) =>
      sends.bindAgentSession(agentId, sessionId, updatedAt, (items) => writer.persistSends(items)),
    confirmSendForLines: (sessionId: ProviderSessionId, lines, updatedAt) =>
      sends.confirmForLines(sessionId, lines, updatedAt, (items) => writer.persistSends(items)),
    listSendJournals: async (): Promise<readonly SendJournal[]> => sends.list(),
    acceptPendingDelivery: (input) =>
      deliveries.accept(input.delivery, (items) => writer.persistDeliveries(items)),
    transitionPendingDelivery: (input) =>
      deliveries.transition(input, (items) => writer.persistDeliveries(items)),
    listPendingDeliveries: async () => deliveries.list(),
    setConversationView: (input) =>
      conversations.set(input, (mutation) => writer.persistConversation(mutation)),
    getConversationView: async (id) => conversations.get(id),
    listConversationViews: async () => conversations.list(),
    replaceProjections: (result) =>
      projections.replace(result, (value) => writer.persistProjections(value)),
    readProjections: async () => projections.read(),
    scanTranscriptEvents: async (
      after?: EventCursor,
      limit?: number,
    ): Promise<readonly TranscriptEvent[]> => transcripts.scanEvents(after, limit),
    close: async () => undefined,
  };
}

/** Opens canonical Messaging persistence and replays transcript, send and delivery facts. */
export async function openFoundationTranscriptStore(
  options: FoundationTranscriptStoreOptions,
): Promise<TranscriptStore> {
  const handle: ScopedStoreHandle = composeHandle({
    root: options.root,
    dataRoot: options.dataRoot,
    capability: 'messaging',
    allowedKinds: ['messagingStoreOp'],
    principal: 'sys_messaging',
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
  });
  const restored = await restoreFoundationMessagingStore(handle);
  const writer = new FoundationMessagingWriter(
    handle,
    restored.transcriptSequence,
    restored.sendSequence,
    restored.deliverySequence,
    restored.conversationSequence,
    restored.projectionSequence,
  );
  return storeFacade(restored, writer);
}
