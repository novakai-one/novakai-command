import type {
  ProviderSourceGrowth,
  ProviderSourceStat,
} from '../../contract/ports/provider-transcript-source.js';
import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { Timestamp } from '../../contract/types.js';
import { present } from '../send/sparse.js';
import {
  digest,
  mintIngestCheckpointId,
  mintProviderResumeId,
  mintProviderSessionId,
  mintTranscriptLineId,
} from './mint.js';
import type { NormalizedExtent, NormalizedGrowth } from './normalize-growth.js';

/**
 * The three durable records ingestion writes — ProviderSession,
 * TranscriptLine, IngestCheckpoint — are built here and nowhere else. Every
 * branded value comes from mint.ts, so this file contains no casts.
 */

/** Builds or refreshes the ProviderSession discovered at one provider source. */
export function providerSessionFor(
  source: ProviderSourceStat,
  resumeId: string | undefined,
  timestamp: Timestamp,
  existing: ProviderSession | undefined,
): ProviderSession {
  const discoveredResumeId = existing?.resumeId ?? resumeId;
  return {
    id: existing?.id ?? mintProviderSessionId(source.provider, resumeId ?? source.sourceId),
    kind: 'provider-session',
    schemaVersion: 1,
    createdAt: existing?.createdAt ?? timestamp,
    provider: source.provider,
    sourceIds: [...new Set([...(existing?.sourceIds ?? []), source.sourceId])],
    status: existing?.status ?? 'adoption-pending',
    ...present('agentId', existing?.agentId),
    ...present('resumeId', discoveredResumeId === undefined
      ? undefined
      : mintProviderResumeId(discoveredResumeId)),
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
    id: mintTranscriptLineId(session.id, value.providerLineId, extent.raw),
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
    ...present('turnId', value.turnId),
    ...present('parentTurnId', value.parentTurnId),
    ...present('toolCall', value.toolCall),
    ...present('tokenUsage', value.tokenUsage),
    ...present('providerOccurredAt', value.providerOccurredAt),
    ...present('correlationHint', value.correlationHint),
    ...present('agentIdentity', value.agentIdentity),
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
    id: mintIngestCheckpointId(source.sourceId),
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
