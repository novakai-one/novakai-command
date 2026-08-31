import type {
  ProviderNormalizer,
  ProviderSourceGrowth,
  ProviderSourceStat,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type { IngestCheckpoint } from "../../contract/records/ingest-checkpoint.js";
import type { ProviderSession } from "../../contract/records/provider-session.js";
import type { ProviderName, Timestamp } from "../../contract/types.js";
import { present } from '../sparse.js';
import type { ExternalAdoptionRuntimePolicy } from "./classify-session.js";
import { providerSessionFor } from "./ingest-records.js";
import type { IngestionStore } from "./ingest-store.js";
import {
  normalizeGrowth,
  type NormalizedGrowth,
} from "./normalize-growth.js";
import {
  AmbiguousProviderSessionEvidenceError,
  reconcileProviderSessionEvidence,
} from "./reconcile.js";

/** One source fully read, normalized, and resolved — ready to classify. */
export interface PreparedSource {
  readonly source: ProviderSourceStat;
  readonly growth: ProviderSourceGrowth;
  readonly normalized: NormalizedGrowth;
  readonly storedCheckpoint: IngestCheckpoint | null;
  readonly existing?: ProviderSession;
  readonly discovered: ProviderSession;
  readonly now: Timestamp;
}

/** The slice of ingestion dependencies prepareSource reads through. */
export interface PrepareDependencies {
  readonly store: Pick<IngestionStore, 'getCheckpoint'>;
  readonly source: Pick<ProviderTranscriptSource, 'readGrowth'>;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly adoption?: ExternalAdoptionRuntimePolicy;
  readonly now: () => Timestamp;
}

/**
 * Reads and normalizes one source's growth and resolves which stored session
 * the evidence names. Returns null when the source has not moved since the
 * stored checkpoint or yields no complete records.
 */
export async function prepareSource(
  dependencies: PrepareDependencies,
  source: ProviderSourceStat,
  sessions: readonly ProviderSession[],
): Promise<PreparedSource | null> {
  const storedCheckpoint = await dependencies.store.getCheckpoint(source.sourceId);
  const rereading = isReclassification(dependencies, source, sessions);
  const readCheckpoint = rereading ? null : storedCheckpoint;
  if (!hasMoved(source, readCheckpoint)) return null;
  const growth = await readSourceGrowth(
    dependencies, source, readCheckpoint, storedCheckpoint, rereading,
  );
  const normalized = normalizeGrowth(
    dependencies.normalizers[source.provider],
    growth,
    readCheckpoint,
  );
  if (normalized.items.length === 0) return null;
  return resolvePreparedSession(dependencies, source, sessions, growth, normalized, storedCheckpoint);
}

/** A discovered-only source that just became adoption-eligible must be re-read from byte zero. */
const isReclassification = (
  dependencies: PrepareDependencies,
  source: ProviderSourceStat,
  sessions: readonly ProviderSession[],
): boolean =>
  sessions.find((candidate) => candidate.sourceIds.includes(source.sourceId))?.status
    === 'discovered-only'
  && source.adoptionEligible
  && dependencies.adoption !== undefined;

/** Unchanged offset and signature mean nothing new since the stored checkpoint. */
const hasMoved = (source: ProviderSourceStat, checkpoint: IngestCheckpoint | null): boolean =>
  checkpoint === null
  || checkpoint.offset !== source.size
  || checkpoint.fileSignature.device !== source.device
  || checkpoint.fileSignature.inode !== source.inode;

/**
 * Reads one source's growth. A source first seen outside the adoption roots
 * has a metadata-only checkpoint; re-reading it from byte zero must begin a
 * new source epoch, otherwise the store treats the lower offset as an
 * already-committed batch and drops the newly authorised history.
 */
async function readSourceGrowth(
  dependencies: PrepareDependencies,
  source: ProviderSourceStat,
  readCheckpoint: IngestCheckpoint | null,
  storedCheckpoint: IngestCheckpoint | null,
  rereading: boolean,
): Promise<ProviderSourceGrowth> {
  const growth = await dependencies.source.readGrowth(source, readCheckpoint);
  if (!rereading || storedCheckpoint === null) return growth;
  return { ...growth, sourceEpoch: storedCheckpoint.sourceEpoch + 1 };
}

/** Resolves which stored session the evidence names, then assembles the prepared source. */
async function resolvePreparedSession(
  dependencies: PrepareDependencies,
  source: ProviderSourceStat,
  sessions: readonly ProviderSession[],
  growth: ProviderSourceGrowth,
  normalized: NormalizedGrowth,
  storedCheckpoint: IngestCheckpoint | null,
): Promise<PreparedSource> {
  const resumeId = normalized.items.find((item) => item.value.resumeId !== undefined)
    ?.value.resumeId ?? source.resumeIdHint;
  const resolution = reconcileProviderSessionEvidence(sessions, source, resumeId);
  if (resolution.kind === 'ambiguous') {
    throw new AmbiguousProviderSessionEvidenceError(
      source.sourceId,
      resumeId,
      resolution.sessionIds,
    );
  }
  const existing = resolution.kind === 'unique' ? resolution.session : undefined;
  const timestamp = dependencies.now();
  return {
    source,
    growth,
    normalized,
    storedCheckpoint,
    ...present('existing', existing),
    discovered: providerSessionFor(source, resumeId, timestamp, existing),
    now: timestamp,
  };
}
