import type {
  TranscriptBatchInput,
  TranscriptBatchResult,
  TranscriptEvent,
  TranscriptLineQuery,
} from "../../contract/ports/transcript-store.js";
import type { IngestCheckpoint } from "../../contract/records/ingest-checkpoint.js";
import type { ProviderSession } from "../../contract/records/provider-session.js";
import type { TranscriptLine } from "../../contract/records/transcript-line.js";
import type { EventCursor, TranscriptSourceId } from "../../contract/types.js";

/** Replay envelope used by durable TranscriptStore adapters. */
export interface PersistedTranscriptBatch {
  readonly sequence: number;
  readonly input: TranscriptBatchInput;
}

/** One replayable ProviderSession upsert in durable sequence order. */
export interface PersistedProviderSession {
  readonly sequence: number;
  readonly session: ProviderSession;
}

const checkpointEqual = (
  left: IngestCheckpoint | null,
  right: IngestCheckpoint | null,
): boolean => left?.id === right?.id
  && left?.sourceEpoch === right?.sourceEpoch
  && left?.offset === right?.offset
  && left?.fileSignature.device === right?.fileSignature.device
  && left?.fileSignature.inode === right?.fileSignature.inode
  && left?.fileSignature.tailHash === right?.fileSignature.tailHash;

const mergeSession = (
  current: ProviderSession | undefined,
  incoming: ProviderSession,
): ProviderSession => {
  if (current === undefined) return incoming;
  if (current.provider !== incoming.provider) {
    throw new Error(`ProviderSession ${incoming.id} provider conflict`);
  }
  if (current.resumeId !== undefined && incoming.resumeId !== undefined
    && current.resumeId !== incoming.resumeId) {
    throw new Error(`ProviderSession ${incoming.id} resume handle conflict`);
  }
  if (current.agentId !== undefined && incoming.agentId !== undefined
    && current.agentId !== incoming.agentId) {
    throw new Error(`ProviderSession ${incoming.id} Agent assignment conflict`);
  }
  return {
    ...current,
    sourceIds: [...new Set([...current.sourceIds, ...incoming.sourceIds])],
    status: incoming.status,
    ...(current.resumeId === undefined && incoming.resumeId !== undefined
      ? { resumeId: incoming.resumeId } : {}),
    ...(current.agentId === undefined && incoming.agentId !== undefined
      ? { agentId: incoming.agentId } : {}),
  };
};

/** Serialized semantic state shared by volatile and durable store adapters. */
export class TranscriptState {
  private readonly checkpoints = new Map<TranscriptSourceId, IngestCheckpoint>();
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly lines = new Map<string, TranscriptLine>();
  private readonly events: TranscriptEvent[] = [];
  private eventSequence = 0;
  private mutationTail: Promise<unknown> = Promise.resolve();

  restore(batches: readonly PersistedTranscriptBatch[]): void {
    for (const batch of [...batches].sort((left, right) => left.sequence - right.sequence)) {
      this.apply(batch.input);
    }
  }

  restoreSessions(sessions: readonly PersistedProviderSession[]): void {
    for (const item of [...sessions].sort((left, right) => left.sequence - right.sequence)) {
      this.applySession(item.session);
    }
  }

  getCheckpoint(sourceId: TranscriptSourceId): IngestCheckpoint | null {
    return this.checkpoints.get(sourceId) ?? null;
  }

  commit(
    input: TranscriptBatchInput,
    persist?: (input: TranscriptBatchInput) => Promise<void>,
  ): Promise<TranscriptBatchResult> {
    const run = this.mutationTail.then(
      () => this.commitSerialized(input, persist),
      () => this.commitSerialized(input, persist),
    );
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  upsertSession(
    session: ProviderSession,
    persist?: (session: ProviderSession) => Promise<void>,
  ): Promise<ProviderSession> {
    const run = this.mutationTail.then(
      async () => {
        const merged = mergeSession(this.sessions.get(session.id), session);
        if (persist !== undefined) await persist(merged);
        return this.applySession(merged);
      },
      async () => {
        const merged = mergeSession(this.sessions.get(session.id), session);
        if (persist !== undefined) await persist(merged);
        return this.applySession(merged);
      },
    );
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async commitSerialized(
    input: TranscriptBatchInput,
    persist?: (input: TranscriptBatchInput) => Promise<void>,
  ): Promise<TranscriptBatchResult> {
    const current = this.getCheckpoint(input.checkpoint.sourceId);
    if (current !== null
      && current.sourceEpoch === input.checkpoint.sourceEpoch
      && current.offset >= input.checkpoint.offset) {
      const duplicates = input.lines.filter((line) => this.lines.has(line.id)).length;
      return { added: 0, duplicates, checkpoint: current };
    }
    if (!checkpointEqual(current, input.expectedCheckpoint)) {
      throw new Error(`Ingest checkpoint conflict for ${input.checkpoint.sourceId}`);
    }
    if (input.checkpoint.sourceEpoch === input.expectedCheckpoint?.sourceEpoch
      && input.checkpoint.offset < input.expectedCheckpoint.offset) {
      throw new Error(`Ingest checkpoint moved backwards for ${input.checkpoint.sourceId}`);
    }
    if (input.lines.some((line) => line.sessionId !== input.session.id)) {
      throw new Error("TranscriptLine references a different ProviderSession");
    }
    if (persist !== undefined) await persist(input);
    return this.apply(input);
  }

  private apply(input: TranscriptBatchInput): TranscriptBatchResult {
    const session = this.applySession(input.session);
    let added = 0;
    let duplicates = 0;
    for (const line of input.lines) {
      if (this.lines.has(line.id)) {
        duplicates += 1;
        continue;
      }
      this.lines.set(line.id, line);
      added += 1;
      this.pushEvent({
        kind: "transcript-line.appended",
        sessionId: session.id,
        transcriptLineId: line.id,
      });
    }
    this.checkpoints.set(input.checkpoint.sourceId, input.checkpoint);
    return { added, duplicates, checkpoint: input.checkpoint };
  }

  private applySession(incoming: ProviderSession): ProviderSession {
    const existing = this.sessions.get(incoming.id);
    const session = mergeSession(existing, incoming);
    this.sessions.set(session.id, session);
    if (existing === undefined) {
      this.pushEvent({ kind: "provider-session.registered", sessionId: session.id });
    }
    return session;
  }

  private pushEvent(input: Omit<TranscriptEvent, "cursor">): void {
    this.eventSequence += 1;
    this.events.push({ ...input, cursor: `event_${this.eventSequence}` as EventCursor });
  }

  listProviderSessions(): readonly ProviderSession[] {
    return [...this.sessions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listTranscriptLines(query: TranscriptLineQuery = {}): readonly TranscriptLine[] {
    const sessionForResume = query.resumeId === undefined
      ? undefined
      : [...this.sessions.values()].find((session) => session.resumeId === query.resumeId)?.id;
    return [...this.lines.values()]
      .filter((line) => query.sessionId === undefined || line.sessionId === query.sessionId)
      .filter((line) => query.provider === undefined || line.provider === query.provider)
      .filter((line) => query.sourceId === undefined || line.sourcePosition.sourceId === query.sourceId)
      .filter((line) => query.resumeId === undefined || line.sessionId === sessionForResume)
      .sort((left, right) =>
        left.sourcePosition.sourceId.localeCompare(right.sourcePosition.sourceId)
        || left.sourcePosition.sourceEpoch - right.sourcePosition.sourceEpoch
        || left.sourcePosition.offset - right.sourcePosition.offset);
  }

  getTranscriptLine(id: TranscriptLine['id']): TranscriptLine | null {
    return this.lines.get(id) ?? null;
  }

  scanEvents(after?: EventCursor, limit = 256): readonly TranscriptEvent[] {
    const sequence = after === undefined ? 0 : Number(after.slice("event_".length));
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid EventCursor");
    return this.events.slice(sequence, sequence + Math.max(1, Math.min(limit, 256)));
  }
}
