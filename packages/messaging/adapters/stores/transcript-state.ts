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
import { MessagingError } from "../../contract/types.js";
import { parseEventCursor } from "../../contract/event-cursor.js";
import { compareStrings } from "../../core/compare.js";
import { present } from '../../core/sparse.js';

/** Event cursors mint here only, checked against the contract pattern — a mint failure is a defect. */
const mintEventCursor = (sequence: number): EventCursor => {
  const minted = parseEventCursor(`event_${sequence}`);
  if (minted === undefined) throw new Error(`EventCursor mint failed for sequence ${sequence}`);
  return minted;
};

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

/** A commit at or behind the stored checkpoint already happened; only duplicates remain. */
const alreadyCommitted = (current: IngestCheckpoint, input: TranscriptBatchInput): boolean =>
  current.sourceEpoch === input.checkpoint.sourceEpoch
  && current.offset >= input.checkpoint.offset;

/** A checkpoint throw that ingest maps to the checkpoint-conflict failure kind. */
const checkpointConflict = (sourceId: TranscriptSourceId, detail: string): MessagingError =>
  new MessagingError('ConcurrentModification', {
    message: `Ingest checkpoint ${detail} for ${sourceId}`,
    fields: { sourceId, conflict: 'checkpoint' },
  });

/** The batch must continue exactly from the stored checkpoint — never sideways, never backwards. */
const requireExpectedCheckpoint = (
  current: IngestCheckpoint | null,
  input: TranscriptBatchInput,
): void => {
  if (!checkpointEqual(current, input.expectedCheckpoint)) {
    throw checkpointConflict(input.checkpoint.sourceId, 'conflict');
  }
  if (input.checkpoint.sourceEpoch === input.expectedCheckpoint?.sourceEpoch
    && input.checkpoint.offset < input.expectedCheckpoint.offset) {
    throw checkpointConflict(input.checkpoint.sourceId, 'moved backwards');
  }
};

/** Every line in a batch belongs to the batch's session; mixing sessions is a caller defect. */
const requireOwnLines = (input: TranscriptBatchInput): void => {
  if (input.lines.some((line) => line.sessionId !== input.session.id)) {
    throw new Error("TranscriptLine references a different ProviderSession");
  }
};

/** True when both sides supply a value and they disagree. */
const disagrees = (left: string | undefined, right: string | undefined): boolean =>
  left !== undefined && right !== undefined && left !== right;

/** A stored session's identity evidence contradicting itself: typed, permanent, host-actionable. */
const sessionConflict = (sessionId: string, field: string): MessagingError =>
  new MessagingError('IdempotencyConflict', {
    message: `ProviderSession ${sessionId} ${field} conflict`,
    fields: { sessionId, field, conflict: 'session-identity' },
  });

/** The identity facts a stored session never trades away; a disagreement is a typed conflict. */
const requireCompatibleSession = (current: ProviderSession, incoming: ProviderSession): void => {
  if (current.provider !== incoming.provider) throw sessionConflict(incoming.id, 'provider');
  if (disagrees(current.resumeId, incoming.resumeId)) throw sessionConflict(incoming.id, 'resumeId');
  if (disagrees(current.agentId, incoming.agentId)) throw sessionConflict(incoming.id, 'agentId');
};

const mergeSession = (
  current: ProviderSession | undefined,
  incoming: ProviderSession,
): ProviderSession => {
  if (current === undefined) return incoming;
  requireCompatibleSession(current, incoming);
  return {
    ...current,
    sourceIds: [...new Set([...current.sourceIds, ...incoming.sourceIds])],
    status: incoming.status,
    ...present('resumeId', current.resumeId ?? incoming.resumeId),
    ...present('agentId', current.agentId ?? incoming.agentId),
  };
};

/**
 * Serialized semantic state shared by volatile and durable store adapters.
 * Crash recovery: persist precedes apply, so a crash mid-step replays from
 * the store on next open.
 */
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
    const commitNext = () => this.commitSerialized(input, persist);
    const mutation = this.mutationTail.then(commitNext, commitNext);
    this.mutationTail = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  upsertSession(
    session: ProviderSession,
    persist?: (session: ProviderSession) => Promise<void>,
  ): Promise<ProviderSession> {
    const upsert = async () => {
      const merged = mergeSession(this.sessions.get(session.id), session);
      if (persist !== undefined) await persist(merged);
      return this.applySession(merged);
    };
    const mutation = this.mutationTail.then(upsert, upsert);
    this.mutationTail = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  private async commitSerialized(
    input: TranscriptBatchInput,
    persist?: (input: TranscriptBatchInput) => Promise<void>,
  ): Promise<TranscriptBatchResult> {
    const current = this.getCheckpoint(input.checkpoint.sourceId);
    if (current !== null && alreadyCommitted(current, input)) {
      const duplicates = input.lines.filter((line) => this.lines.has(line.id)).length;
      return { added: 0, duplicates, checkpoint: current };
    }
    requireExpectedCheckpoint(current, input);
    requireOwnLines(input);
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
    this.events.push({ ...input, cursor: mintEventCursor(this.eventSequence) });
  }

  listProviderSessions(): readonly ProviderSession[] {
    return [...this.sessions.values()].sort((left, right) =>
      compareStrings(left.createdAt, right.createdAt));
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
        compareStrings(left.sourcePosition.sourceId, right.sourcePosition.sourceId)
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
