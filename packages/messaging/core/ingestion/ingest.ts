import { createHash } from "node:crypto";
import type { IngestResult } from "../../contract/runtime.js";
import type {
  NormalizedProviderLine,
  ProviderNormalizer,
  ProviderSourceGrowth,
  ProviderSourceStat,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type { TranscriptStore } from "../../contract/ports/transcript-store.js";
import type { IngestCheckpoint } from "../../contract/records/ingest-checkpoint.js";
import type { ProviderSession } from "../../contract/records/provider-session.js";
import type { TranscriptLine } from "../../contract/records/transcript-line.js";
import type {
  IngestCheckpointId,
  ProviderName,
  ProviderResumeId,
  ProviderSessionId,
  Timestamp,
  TranscriptLineId,
} from "../../contract/types.js";
import type { AgentDirectory } from "../../contract/ports/agent-directory.js";
import { assignProviderSession } from "./assign-session.js";
import { confirmPendingSends } from "../send/confirm.js";

interface IngestionDependencies {
  readonly store: TranscriptStore;
  readonly source: ProviderTranscriptSource;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly now: () => string;
  readonly agentDirectory?: AgentDirectory;
}

const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function uuidFrom(value: string): string {
  const hex = digest(value).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

const sessionIdFor = (provider: ProviderName, identity: string): ProviderSessionId =>
  `sess_${uuidFrom(`${provider}:${identity}`)}` as ProviderSessionId;

const checkpointIdFor = (sourceId: string): IngestCheckpointId =>
  `ingestCheckpoint_${digest(sourceId)}` as IngestCheckpointId;

const lineIdFor = (
  sessionId: ProviderSessionId,
  providerLineId: string | undefined,
  raw: string,
): TranscriptLineId => `transcriptLine_${digest(
  `${sessionId}:${providerLineId ?? digest(raw)}`,
)}` as TranscriptLineId;

interface Extent {
  readonly raw: string;
  readonly offset: number;
  readonly nextOffset: number;
}

function completeExtents(bytes: Uint8Array, fromOffset: number): {
  readonly extents: readonly Extent[];
  readonly committedBytes: Uint8Array;
} {
  const buffer = Buffer.from(bytes);
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return { extents: [], committedBytes: Buffer.alloc(0) };
  const committedBytes = buffer.subarray(0, lastNewline + 1);
  const extents: Extent[] = [];
  let start = 0;
  while (start < committedBytes.length) {
    const newline = committedBytes.indexOf(0x0a, start);
    if (newline < 0) break;
    const end = committedBytes[newline - 1] === 0x0d ? newline - 1 : newline;
    extents.push({
      raw: committedBytes.subarray(start, end).toString("utf8"),
      offset: fromOffset + start,
      nextOffset: fromOffset + newline + 1,
    });
    start = newline + 1;
  }
  return { extents, committedBytes };
}

function sessionFor(
  source: ProviderSourceStat,
  resumeId: string | undefined,
  now: Timestamp,
  existing: ProviderSession | undefined,
): ProviderSession {
  const sessionId = existing?.id
    ?? sessionIdFor(source.provider, resumeId ?? source.sourceId);
  return {
    id: sessionId,
    kind: "provider-session",
    schemaVersion: 1,
    createdAt: existing?.createdAt ?? now,
    provider: source.provider,
    sourceIds: [...new Set([...(existing?.sourceIds ?? []), source.sourceId])],
    status: existing?.status ?? "adoption-pending",
    ...(existing?.agentId === undefined ? {} : { agentId: existing.agentId }),
    ...((existing?.resumeId ?? resumeId) === undefined
      ? {} : { resumeId: (existing?.resumeId ?? resumeId) as ProviderResumeId }),
  };
}

interface NormalizedExtent {
  readonly extent: Extent;
  readonly value: NormalizedProviderLine;
}

interface NormalizedGrowth {
  readonly committedBytes: Uint8Array;
  readonly items: readonly NormalizedExtent[];
  readonly baseTurnIndex: number;
}

function normalizeGrowth(
  normalizer: ProviderNormalizer,
  growth: ProviderSourceGrowth,
  checkpoint: IngestCheckpoint | null,
): NormalizedGrowth {
  const parsed = completeExtents(growth.bytes, growth.fromOffset);
  const baseTurnIndex = checkpoint?.sourceEpoch === growth.sourceEpoch
    ? checkpoint.nextTurnIndex
    : 0;
  return {
    committedBytes: parsed.committedBytes,
    baseTurnIndex,
    items: parsed.extents.map((extent, index) => ({
      extent,
      value: normalizer.normalize(extent, baseTurnIndex + index),
    })),
  };
}

function transcriptLine(
  item: NormalizedExtent,
  index: number,
  source: ProviderSourceStat,
  growth: ProviderSourceGrowth,
  session: ProviderSession,
  now: Timestamp,
  baseTurnIndex: number,
): TranscriptLine {
  const { extent, value } = item;
  return {
    id: lineIdFor(session.id, value.providerLineId, extent.raw),
    kind: "transcript-line",
    schemaVersion: 1,
    createdAt: now,
    sessionId: session.id,
    provider: source.provider,
    sourcePosition: {
      sourceId: source.sourceId,
      sourceEpoch: growth.sourceEpoch,
      offset: extent.offset,
      nextOffset: extent.nextOffset,
    },
    turnIndex: baseTurnIndex + index,
    role: value.role,
    text: value.text,
    raw: extent.raw,
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
    ...(value.parentTurnId === undefined ? {} : { parentTurnId: value.parentTurnId }),
    ...(value.toolCall === undefined ? {} : { toolCall: value.toolCall }),
    ...(value.tokenUsage === undefined ? {} : { tokenUsage: value.tokenUsage }),
    ...(value.providerOccurredAt === undefined
      ? {} : { providerOccurredAt: value.providerOccurredAt }),
    ...(value.correlationHint === undefined
      ? {} : { correlationHint: value.correlationHint }),
    ...(value.agentIdentity === undefined ? {} : { agentIdentity: value.agentIdentity }),
  };
}

function checkpointFor(
  source: ProviderSourceStat,
  growth: ProviderSourceGrowth,
  previous: IngestCheckpoint | null,
  normalized: NormalizedGrowth,
  now: Timestamp,
): IngestCheckpoint {
  const committedOffset = growth.fromOffset + normalized.committedBytes.byteLength;
  const tail = Buffer.concat([
    Buffer.from(growth.priorTail),
    Buffer.from(normalized.committedBytes),
  ]).subarray(-64);
  return {
    id: checkpointIdFor(source.sourceId),
    kind: "ingest-checkpoint",
    schemaVersion: 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    provider: source.provider,
    sourceId: source.sourceId,
    sourceEpoch: growth.sourceEpoch,
    offset: committedOffset,
    nextTurnIndex: normalized.baseTurnIndex + normalized.items.length,
    fileSignature: { ...growth.signatureAtRead, tailHash: digest(tail) },
  };
}

function existingSession(
  sessions: readonly ProviderSession[],
  source: ProviderSourceStat,
  resumeId: string | undefined,
): ProviderSession | undefined {
  return sessions.find((candidate) =>
    candidate.sourceIds.includes(source.sourceId)
    || (resumeId !== undefined && candidate.resumeId === resumeId));
}

async function ingestSource(
  dependencies: IngestionDependencies,
  source: ProviderSourceStat,
  sessions: readonly ProviderSession[],
): Promise<{
  added: number;
  duplicates: number;
  registered: number;
  session?: ProviderSession;
}> {
  const checkpoint = await dependencies.store.getCheckpoint(source.sourceId);
  if (checkpoint !== null
    && checkpoint.offset === source.size
    && checkpoint.fileSignature.device === source.device
    && checkpoint.fileSignature.inode === source.inode) {
    return { added: 0, duplicates: 0, registered: 0 };
  }
  const growth = await dependencies.source.readGrowth(source, checkpoint);
  const normalized = normalizeGrowth(
    dependencies.normalizers[source.provider],
    growth,
    checkpoint,
  );
  if (normalized.items.length === 0) return { added: 0, duplicates: 0, registered: 0 };
  const resumeId = normalized.items.find((item) => item.value.resumeId !== undefined)?.value.resumeId
    ?? source.resumeIdHint;
  const existing = existingSession(sessions, source, resumeId);
  const now = dependencies.now() as Timestamp;
  const discovered = sessionFor(source, resumeId, now, existing);
  const session = await assignProviderSession({
    session: discovered,
    store: dependencies.store,
    markers: normalized.items.flatMap((item) =>
      item.value.agentIdentity === undefined ? [] : [item.value.agentIdentity]),
    ...(dependencies.agentDirectory === undefined
      ? {} : { directory: dependencies.agentDirectory }),
  });
  const lines = normalized.items.map((item, index) =>
    transcriptLine(item, index, source, growth, session, now, normalized.baseTurnIndex));
  const nextCheckpoint = checkpointFor(source, growth, checkpoint, normalized, now);
  const committed = await dependencies.store.commitIngestBatch({
    expectedCheckpoint: checkpoint,
    session,
    lines,
    checkpoint: nextCheckpoint,
  });
  return {
    added: committed.added,
    duplicates: committed.duplicates,
    registered: existing === undefined ? 1 : 0,
    session,
  };
}

/** Executes one serialized provider scan and atomic ingest pass. */
export async function ingestNow(
  dependencies: IngestionDependencies,
): Promise<IngestResult> {
  const sources = await dependencies.source.scan();
  const sessions = [...await dependencies.store.listProviderSessions()];
  let added = 0;
  let duplicates = 0;
  let sessionsRegistered = 0;
  for (const source of sources) {
    const result = await ingestSource(dependencies, source, sessions);
    added += result.added;
    duplicates += result.duplicates;
    sessionsRegistered += result.registered;
    if (result.session !== undefined) {
      const current = sessions.findIndex((candidate) => candidate.id === result.session?.id);
      if (current < 0) sessions.push(result.session);
      else sessions[current] = result.session;
    }
  }
  await confirmPendingSends(dependencies.store, dependencies.now());
  return { sources: sources.length, added, duplicates, sessionsRegistered };
}
