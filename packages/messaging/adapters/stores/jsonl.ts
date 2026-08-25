import { createHash } from "node:crypto";
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
} from "@novakai/foundation/contract";
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
import { TranscriptState, type PersistedTranscriptBatch } from "./transcript-state.js";

/** Canonical Foundation-store location and lock policy for TranscriptLines. */
export interface FoundationTranscriptStoreOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly lockTimeoutMs?: number;
}

interface TranscriptIngestStoreOp {
  readonly op: "transcript-ingest";
  readonly batch: TranscriptBatchInput;
}

interface TranscriptMessagingStoreRecord {
  readonly kind: "messagingStoreOp";
  readonly id: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly permissionLevel: "private";
  readonly createdBy: string;
  readonly storeSequence: number;
  readonly transcriptSequence: number;
  readonly operationKey: string;
  readonly payloadDigest: string;
  readonly storeOp: TranscriptIngestStoreOp;
}

const isTranscriptRecord = (value: unknown): value is TranscriptMessagingStoreRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<TranscriptMessagingStoreRecord>;
  return record.kind === "messagingStoreOp"
    && typeof record.transcriptSequence === "number"
    && typeof record.storeOp === "object"
    && record.storeOp !== null
    && record.storeOp.op === "transcript-ingest";
};

async function restoreState(handle: ScopedStoreHandle): Promise<{
  readonly state: TranscriptState;
  readonly transcriptSequence: number;
}> {
  const listed = await listObjects<unknown>(
    handle,
    "messagingStoreOp",
    undefined,
    { limit: 1_000_000 },
  );
  if (!listed.ok) throw new Error(`Messaging transcript replay failed: ${listed.error.code}`);
  let transcriptSequence = 0;
  const persisted: PersistedTranscriptBatch[] = [];
  for (const item of listed.value.items) {
    if (isTranscriptRecord(item.object)) {
      transcriptSequence = Math.max(transcriptSequence, item.object.transcriptSequence);
      persisted.push({
        sequence: item.object.transcriptSequence,
        input: item.object.storeOp.batch,
      });
    }
  }
  const state = new TranscriptState();
  state.restore(persisted);
  return { state, transcriptSequence };
}

class FoundationTranscriptWriter {
  constructor(
    private readonly handle: ScopedStoreHandle,
    private transcriptSequence: number,
  ) {}

  async persist(input: TranscriptBatchInput): Promise<void> {
    const operationKey = [
      "transcript-ingest",
      input.checkpoint.sourceId,
      input.checkpoint.sourceEpoch,
      input.expectedCheckpoint?.offset ?? 0,
      input.checkpoint.offset,
    ].join(":");
    const storeOp: TranscriptIngestStoreOp = { op: "transcript-ingest", batch: input };
    const payloadDigest = createHash("sha256").update(canonicalJson(storeOp)).digest("hex");
    const id = mintMessagingStoreOpId(operationKey) as unknown as ObjectId;
    const existing = await getObject<TranscriptMessagingStoreRecord>(
      this.handle,
      "messagingStoreOp",
      id,
    );
    if (existing.ok && !isAbsent(existing.value)) {
      if (existing.value.object.payloadDigest !== payloadDigest) {
        throw new Error(`Messaging transcript operation ${operationKey} conflicts`);
      }
      return;
    }
    this.transcriptSequence += 1;
    const record: TranscriptMessagingStoreRecord = {
      kind: "messagingStoreOp",
      id: id as string,
      schemaVersion: 1,
      createdAt: input.checkpoint.updatedAt,
      permissionLevel: "private",
      createdBy: "overridden-by-foundation",
      storeSequence: 0,
      transcriptSequence: this.transcriptSequence,
      operationKey,
      payloadDigest,
      storeOp,
    };
    const written = await createObject(
      this.handle,
      record as unknown as Record<string, unknown> & {
        kind: string;
        id: string;
        schemaVersion: number;
        createdAt: string;
        permissionLevel: "private";
        createdBy: string;
      },
      deriveClientOpId(`messaging:${operationKey}`),
    );
    if (!written.ok) {
      this.transcriptSequence -= 1;
      throw new Error(`Messaging transcript append failed: ${written.error.code}`);
    }
  }
}

function storeFacade(
  state: TranscriptState,
  writer: FoundationTranscriptWriter,
): TranscriptStore {
  return {
    getCheckpoint: async (sourceId: TranscriptSourceId): Promise<IngestCheckpoint | null> =>
      state.getCheckpoint(sourceId),
    commitIngestBatch: (input: TranscriptBatchInput): Promise<TranscriptBatchResult> =>
      state.commit(input, (batch) => writer.persist(batch)),
    listProviderSessions: async (): Promise<readonly ProviderSession[]> =>
      state.listProviderSessions(),
    listTranscriptLines: async (query?: TranscriptLineQuery): Promise<readonly TranscriptLine[]> =>
      state.listTranscriptLines(query),
    scanTranscriptEvents: async (after?: EventCursor, limit?: number): Promise<readonly TranscriptEvent[]> =>
      state.scanEvents(after, limit),
    close: async () => undefined,
  };
}

/** Opens canonical Messaging persistence and replays committed ingest batches. */
export async function openFoundationTranscriptStore(
  options: FoundationTranscriptStoreOptions,
): Promise<TranscriptStore> {
  const handle: ScopedStoreHandle = composeHandle({
    root: options.root,
    dataRoot: options.dataRoot,
    capability: "messaging",
    allowedKinds: ["messagingStoreOp"],
    principal: "sys_messaging",
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
  });
  const restored = await restoreState(handle);
  const writer = new FoundationTranscriptWriter(handle, restored.transcriptSequence);
  return storeFacade(restored.state, writer);
}
