import { createHash } from 'node:crypto';
import type {
  ProviderSourceGrowth,
  ProviderSourceStat,
} from '../../contract/ports/provider-transcript-source.js';
import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type {
  IngestCheckpointId,
  ProviderName,
  ProviderResumeId,
  ProviderSessionId,
  Timestamp,
  TranscriptLineId,
} from '../../contract/types.js';
import type { NormalizedExtent, NormalizedGrowth } from './normalize-growth.js';

const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

function uuidFrom(value: string): string {
  const characters = digest(value).slice(0, 32).split('');
  characters[12] = '5';
  characters[16] = [
    '8',
    '9',
    'a',
    'b',
  ][Number.parseInt(characters[16] ?? '0', 16) % 4] ?? '8';
  const joined = characters.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

const sessionIdFor = (provider: ProviderName, identity: string): ProviderSessionId =>
  `sess_${uuidFrom(`${provider}:${identity}`)}` as ProviderSessionId;

const checkpointIdFor = (sourceId: string): IngestCheckpointId =>
  `ingestCheckpoint_${digest(sourceId)}` as IngestCheckpointId;

const lineIdFor = (
  sessionId: ProviderSessionId,
  providerLineId: string | undefined,
  rawLine: string,
): TranscriptLineId => `transcriptLine_${digest(
  `${sessionId}:${providerLineId ?? digest(rawLine)}`,
)}` as TranscriptLineId;

/** Builds or refreshes the ProviderSession discovered at one provider source. */
export function providerSessionFor(
  source: ProviderSourceStat,
  resumeId: string | undefined,
  timestamp: Timestamp,
  existing: ProviderSession | undefined,
): ProviderSession {
  const sessionId = existing?.id
    ?? sessionIdFor(source.provider, resumeId ?? source.sourceId);
  return {
    id: sessionId,
    kind: 'provider-session',
    schemaVersion: 1,
    createdAt: existing?.createdAt ?? timestamp,
    provider: source.provider,
    sourceIds: [...new Set([...(existing?.sourceIds ?? []), source.sourceId])],
    status: existing?.status ?? 'adoption-pending',
    ...(existing?.agentId === undefined ? {} : { agentId: existing.agentId }),
    ...((existing?.resumeId ?? resumeId) === undefined
      ? {} : { resumeId: (existing?.resumeId ?? resumeId) as ProviderResumeId }),
  };
}

/** Converts one normalized provider record into the durable transcript root. */
export function transcriptLineFor(
  item: NormalizedExtent,
  index: number,
  source: ProviderSourceStat,
  growth: ProviderSourceGrowth,
  session: ProviderSession,
  timestamp: Timestamp,
  baseTurnIndex: number,
): TranscriptLine {
  const { extent, value } = item;
  return {
    id: lineIdFor(session.id, value.providerLineId, extent.raw),
    kind: 'transcript-line',
    schemaVersion: 1,
    createdAt: timestamp,
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

/** Advances the per-source checkpoint to the last complete provider record. */
export function ingestCheckpointFor(
  source: ProviderSourceStat,
  growth: ProviderSourceGrowth,
  previous: IngestCheckpoint | null,
  normalized: NormalizedGrowth,
  timestamp: Timestamp,
): IngestCheckpoint {
  const committedOffset = growth.fromOffset + normalized.committedBytes.byteLength;
  const tail = Buffer.concat([
    Buffer.from(growth.priorTail),
    Buffer.from(normalized.committedBytes),
  ]).subarray(-64);
  return {
    id: checkpointIdFor(source.sourceId),
    kind: 'ingest-checkpoint',
    schemaVersion: 1,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    provider: source.provider,
    sourceId: source.sourceId,
    sourceEpoch: growth.sourceEpoch,
    offset: committedOffset,
    nextTurnIndex: normalized.baseTurnIndex + normalized.items.length,
    fileSignature: { ...growth.signatureAtRead, tailHash: digest(tail) },
  };
}

/** Resolves a source or provider resume handle to an already registered session. */
export function findProviderSession(
  sessions: readonly ProviderSession[],
  source: ProviderSourceStat,
  resumeId: string | undefined,
): ProviderSession | undefined {
  return sessions.find((candidate) =>
    candidate.sourceIds.includes(source.sourceId)
    || (resumeId !== undefined && candidate.resumeId === resumeId));
}
