import { createHash } from 'node:crypto';
import {
  canonicalJson,
  composeHandle,
  createObject,
  deriveClientOpId,
  getObject,
  isAbsent,
  listObjects,
  mintMessagingStoreOpId,
  type ObjectId,
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
import {
  SendJournalState,
  type PersistedSendMutation,
} from './send-journal-state.js';
import {
  TranscriptState,
  type PersistedProviderSession,
  type PersistedTranscriptBatch,
} from './transcript-state.js';

/** Canonical Foundation-store location and lock policy for transcript-first Messaging. */
export interface FoundationTranscriptStoreOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly lockTimeoutMs?: number;
}

type MessagingStoreOp =
  | { readonly op: 'transcript-ingest'; readonly batch: TranscriptBatchInput }
  | { readonly op: 'provider-session-upsert'; readonly session: ProviderSession }
  | { readonly op: 'send-journal-mutation'; readonly journals: readonly SendJournal[] };

interface MessagingStoreRecord {
  readonly kind: 'messagingStoreOp';
  readonly id: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly permissionLevel: 'private';
  readonly createdBy: string;
  readonly storeSequence: number;
  readonly transcriptSequence?: number;
  readonly sendSequence?: number;
  readonly operationKey: string;
  readonly payloadDigest: string;
  readonly storeOp: MessagingStoreOp;
}

const recordOf = (value: unknown): MessagingStoreRecord | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<MessagingStoreRecord>;
  if (record.kind !== 'messagingStoreOp'
    || typeof record.operationKey !== 'string'
    || typeof record.payloadDigest !== 'string'
    || typeof record.storeOp !== 'object'
    || record.storeOp === null) return undefined;
  const op = (record.storeOp as { op?: unknown }).op;
  return op === 'transcript-ingest' || op === 'provider-session-upsert'
    || op === 'send-journal-mutation'
    ? record as MessagingStoreRecord : undefined;
};

interface RestoredStore {
  readonly transcripts: TranscriptState;
  readonly sends: SendJournalState;
  readonly transcriptSequence: number;
  readonly sendSequence: number;
}

async function restoreStore(handle: ScopedStoreHandle): Promise<RestoredStore> {
  const listed = await listObjects<unknown>(
    handle,
    'messagingStoreOp',
    undefined,
    { limit: 1_000_000 },
  );
  if (!listed.ok) throw new Error(`Messaging replay failed: ${listed.error.code}`);
  const batches: PersistedTranscriptBatch[] = [];
  const sessions: PersistedProviderSession[] = [];
  const sends: PersistedSendMutation[] = [];
  let transcriptSequence = 0;
  let sendSequence = 0;
  for (const item of listed.value.items) {
    const record = recordOf(item.object);
    if (record === undefined) continue;
    if (record.storeOp.op === 'transcript-ingest') {
      const sequence = record.transcriptSequence ?? 0;
      transcriptSequence = Math.max(transcriptSequence, sequence);
      batches.push({ sequence, input: record.storeOp.batch });
    } else if (record.storeOp.op === 'provider-session-upsert') {
      const sequence = record.transcriptSequence ?? 0;
      transcriptSequence = Math.max(transcriptSequence, sequence);
      sessions.push({ sequence, session: record.storeOp.session });
    } else {
      const sequence = record.sendSequence ?? 0;
      sendSequence = Math.max(sendSequence, sequence);
      sends.push({ sequence, journals: record.storeOp.journals });
    }
  }
  const transcripts = new TranscriptState();
  transcripts.restoreSessions(sessions);
  transcripts.restore(batches);
  const sendState = new SendJournalState();
  sendState.restore(sends);
  return { transcripts, sends: sendState, transcriptSequence, sendSequence };
}

class FoundationMessagingWriter {
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly handle: ScopedStoreHandle,
    private transcriptSequence: number,
    private sendSequence: number,
  ) {}

  persistTranscript(input: TranscriptBatchInput): Promise<void> {
    const operationKey = [
      'transcript-ingest',
      input.checkpoint.sourceId,
      input.checkpoint.sourceEpoch,
      input.expectedCheckpoint?.offset ?? 0,
      input.checkpoint.offset,
    ].join(':');
    return this.persist(
      operationKey,
      { op: 'transcript-ingest', batch: input },
      input.checkpoint.updatedAt,
      'transcript',
    );
  }

  persistSession(session: ProviderSession): Promise<void> {
    const storeOp: MessagingStoreOp = { op: 'provider-session-upsert', session };
    const digest = createHash('sha256').update(canonicalJson(storeOp)).digest('hex');
    return this.persist(
      `provider-session:${session.id}:${digest}`,
      storeOp,
      session.createdAt,
      'transcript',
    );
  }

  persistSends(journals: readonly SendJournal[]): Promise<void> {
    const storeOp: MessagingStoreOp = { op: 'send-journal-mutation', journals };
    const digest = createHash('sha256').update(canonicalJson(storeOp)).digest('hex');
    return this.persist(
      `send-journal:${journals.map((journal) => journal.id).join(',')}:${digest}`,
      storeOp,
      journals[0]?.updatedAt ?? new Date().toISOString(),
      'send',
    );
  }

  private persist(
    operationKey: string,
    storeOp: MessagingStoreOp,
    createdAt: string,
    lane: 'transcript' | 'send',
  ): Promise<void> {
    const operation = () => this.persistSerialized(operationKey, storeOp, createdAt, lane);
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persistSerialized(
    operationKey: string,
    storeOp: MessagingStoreOp,
    createdAt: string,
    lane: 'transcript' | 'send',
  ): Promise<void> {
    const payloadDigest = createHash('sha256').update(canonicalJson(storeOp)).digest('hex');
    const id = mintMessagingStoreOpId(operationKey) as unknown as ObjectId;
    const existing = await getObject<MessagingStoreRecord>(this.handle, 'messagingStoreOp', id);
    if (existing.ok && !isAbsent(existing.value)) {
      if (existing.value.object.payloadDigest !== payloadDigest) {
        throw new Error(`Messaging operation ${operationKey} conflicts`);
      }
      return;
    }
    if (lane === 'transcript') this.transcriptSequence += 1;
    else this.sendSequence += 1;
    const record: MessagingStoreRecord = {
      kind: 'messagingStoreOp',
      id: id as string,
      schemaVersion: 1,
      createdAt,
      permissionLevel: 'private',
      createdBy: 'overridden-by-foundation',
      storeSequence: 0,
      operationKey,
      payloadDigest,
      storeOp,
      ...(lane === 'transcript'
        ? { transcriptSequence: this.transcriptSequence }
        : { sendSequence: this.sendSequence }),
    };
    const written = await createObject(
      this.handle,
      record as unknown as Record<string, unknown> & {
        kind: string;
        id: string;
        schemaVersion: number;
        createdAt: string;
        permissionLevel: 'private';
        createdBy: string;
      },
      deriveClientOpId(`messaging:${operationKey}`),
    );
    if (!written.ok) {
      if (lane === 'transcript') this.transcriptSequence -= 1;
      else this.sendSequence -= 1;
      throw new Error(`Messaging append failed: ${written.error.code}`);
    }
  }
}

function storeFacade(restored: RestoredStore, writer: FoundationMessagingWriter): TranscriptStore {
  const { transcripts, sends } = restored;
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
    scanTranscriptEvents: async (after?: EventCursor, limit?: number): Promise<readonly TranscriptEvent[]> =>
      transcripts.scanEvents(after, limit),
    close: async () => undefined,
  };
}

/** Opens canonical Messaging persistence and replays transcript and send facts. */
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
  const restored = await restoreStore(handle);
  const writer = new FoundationMessagingWriter(
    handle,
    restored.transcriptSequence,
    restored.sendSequence,
  );
  return storeFacade(restored, writer);
}
