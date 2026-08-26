import type { IngestResult } from "../../contract/runtime.js";
import type {
  ProviderNormalizer,
  ProviderSourceGrowth,
  ProviderSourceStat,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type { TranscriptStore } from "../../contract/ports/transcript-store.js";
import type { IngestCheckpoint } from "../../contract/records/ingest-checkpoint.js";
import type { ProviderSession } from "../../contract/records/provider-session.js";
import type {
  ProviderName,
  Timestamp,
} from "../../contract/types.js";
import type { AgentDirectory } from "../../contract/ports/agent-directory.js";
import { confirmPendingSends } from "../send/confirm.js";
import {
  classifyProviderSession,
  type ExternalAdoptionRuntimePolicy,
} from "./classify-session.js";
import {
  normalizeGrowth,
  type NormalizedGrowth,
} from "./normalize-growth.js";
import {
  ingestCheckpointFor,
  providerSessionFor,
  transcriptLineFor,
} from "./ingest-records.js";
import {
  AmbiguousProviderSessionEvidenceError,
  reconcileProviderSessionEvidence,
} from "./reconcile.js";
import { selectSourcesForIngest } from './select-sources.js';

interface IngestionDependencies {
  readonly store: TranscriptStore;
  readonly source: ProviderTranscriptSource;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly now: () => string;
  readonly discoveryFloor: string;
  readonly agentDirectory?: AgentDirectory;
  readonly adoption?: ExternalAdoptionRuntimePolicy;
  readonly storeId?: string;
}

interface SourceIngestResult {
  readonly added: number;
  readonly duplicates: number;
  readonly registered: number;
  readonly session?: ProviderSession;
  readonly adopted: boolean;
  readonly foreign: boolean;
}

interface PreparedSource {
  readonly source: ProviderSourceStat;
  readonly growth: ProviderSourceGrowth;
  readonly normalized: NormalizedGrowth;
  readonly storedCheckpoint: IngestCheckpoint | null;
  readonly existing?: ProviderSession;
  readonly discovered: ProviderSession;
  readonly now: Timestamp;
}

const emptySourceResult = (): SourceIngestResult => ({
  added: 0,
  duplicates: 0,
  registered: 0,
  adopted: false,
  foreign: false,
});

async function prepareSource(
  dependencies: IngestionDependencies,
  source: ProviderSourceStat,
  sessions: readonly ProviderSession[],
): Promise<PreparedSource | null> {
  const existingBySource = sessions.find((candidate) =>
    candidate.sourceIds.includes(source.sourceId));
  const storedCheckpoint = await dependencies.store.getCheckpoint(source.sourceId);
  const shouldReclassify = existingBySource?.status === "discovered-only"
    && source.adoptionEligible
    && dependencies.adoption !== undefined;
  const readCheckpoint = shouldReclassify ? null : storedCheckpoint;
  if (readCheckpoint !== null
    && readCheckpoint.offset === source.size
    && readCheckpoint.fileSignature.device === source.device
    && readCheckpoint.fileSignature.inode === source.inode) return null;

  const growth = await dependencies.source.readGrowth(source, readCheckpoint);
  const normalized = normalizeGrowth(
    dependencies.normalizers[source.provider],
    growth,
    readCheckpoint,
  );
  if (normalized.items.length === 0) return null;
  const resumeId = normalized.items.find((item) => item.value.resumeId !== undefined)?.value.resumeId
    ?? source.resumeIdHint;
  const resolution = reconcileProviderSessionEvidence(sessions, source, resumeId);
  if (resolution.kind === 'ambiguous') {
    throw new AmbiguousProviderSessionEvidenceError(
      source.sourceId,
      resumeId,
      resolution.sessionIds,
    );
  }
  const existing = resolution.kind === 'unique' ? resolution.session : undefined;
  const timestamp = dependencies.now() as Timestamp;
  return {
    source,
    growth,
    normalized,
    storedCheckpoint,
    ...(existing === undefined ? {} : { existing }),
    discovered: providerSessionFor(source, resumeId, timestamp, existing),
    now: timestamp,
  };
}

async function deferSource(
  dependencies: IngestionDependencies,
  prepared: PreparedSource,
  status: "adoption-pending" | "discovered-only",
  foreign = false,
): Promise<SourceIngestResult> {
  const { discovered, existing, growth, normalized, now, source, storedCheckpoint } = prepared;
  const session = await dependencies.store.upsertProviderSession({ ...discovered, status });
  if (status === "discovered-only") {
    await dependencies.store.commitIngestBatch({
      expectedCheckpoint: storedCheckpoint,
      session,
      lines: [],
      checkpoint: ingestCheckpointFor(source, growth, storedCheckpoint, normalized, now),
    });
  }
  return {
    ...emptySourceResult(),
    registered: existing === undefined ? 1 : 0,
    session,
    foreign,
  };
}

async function commitSource(
  dependencies: IngestionDependencies,
  prepared: PreparedSource,
  session: ProviderSession,
  adopted: boolean,
): Promise<SourceIngestResult> {
  const { existing, growth, normalized, now, source, storedCheckpoint } = prepared;
  const lines = normalized.items.map((item, index) =>
    transcriptLineFor(item, index, source, growth, session, now, normalized.baseTurnIndex));
  const committed = await dependencies.store.commitIngestBatch({
    expectedCheckpoint: storedCheckpoint,
    session,
    lines,
    checkpoint: ingestCheckpointFor(source, growth, storedCheckpoint, normalized, now),
  });
  return {
    added: committed.added,
    duplicates: committed.duplicates,
    registered: existing === undefined ? 1 : 0,
    session,
    adopted,
    foreign: false,
  };
}

async function ingestSource(
  dependencies: IngestionDependencies,
  source: ProviderSourceStat,
  sessions: readonly ProviderSession[],
  adoptionBudget: { remaining: number },
): Promise<SourceIngestResult> {
  const prepared = await prepareSource(dependencies, source, sessions);
  if (prepared === null) return emptySourceResult();
  const classification = await classifyProviderSession({
    session: prepared.discovered,
    lines: prepared.normalized.items.map((item) => item.value),
    complete: prepared.normalized.complete,
    adoptionEligible: source.adoptionEligible,
    adoptionRemaining: adoptionBudget.remaining,
    store: dependencies.store,
    now: dependencies.now,
    ...(dependencies.storeId === undefined ? {} : { storeId: dependencies.storeId }),
    ...(dependencies.agentDirectory === undefined
      ? {} : { directory: dependencies.agentDirectory }),
    ...(dependencies.adoption === undefined ? {} : { adoption: dependencies.adoption }),
  });
  if (classification.kind === "defer") {
    return deferSource(dependencies, prepared, classification.status, classification.foreign ?? false);
  }
  const result = await commitSource(
    dependencies,
    prepared,
    classification.session,
    classification.adopted,
  );
  if (result.adopted) adoptionBudget.remaining -= 1;
  return result;
}

/** Executes one serialized provider scan and atomic ingest pass. */
export async function ingestNow(
  dependencies: IngestionDependencies,
): Promise<IngestResult> {
  const scanned = await dependencies.source.scan();
  const sessions = [...await dependencies.store.listProviderSessions()];
  const sources = await selectSourcesForIngest({
    sources: scanned,
    sessions,
    journals: await dependencies.store.listSendJournals(),
    discoveryFloor: dependencies.discoveryFloor,
    ...(dependencies.agentDirectory === undefined
      ? {} : { directory: dependencies.agentDirectory }),
  });
  let added = 0;
  let duplicates = 0;
  let sessionsRegistered = 0;
  let sessionsAdopted = 0;
  let foreignSources = 0;
  const failures = [] as Array<{ sourceId: string; provider: string; message: string }>;
  const adoptionBudget = { remaining: dependencies.adoption?.limitPerTick ?? 0 };
  for (const source of sources) {
    let result: SourceIngestResult;
    try {
      result = await ingestSource(dependencies, source, sessions, adoptionBudget);
    } catch (cause) {
      failures.push({
        sourceId: source.sourceId,
        provider: source.provider,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }
    added += result.added;
    duplicates += result.duplicates;
    sessionsRegistered += result.registered;
    if (result.adopted) sessionsAdopted += 1;
    if (result.foreign) foreignSources += 1;
    if (result.session !== undefined) {
      const current = sessions.findIndex((candidate) => candidate.id === result.session?.id);
      if (current < 0) sessions.push(result.session);
      else sessions[current] = result.session;
    }
  }
  await confirmPendingSends(dependencies.store, dependencies.now());
  return {
    sources: sources.length,
    added,
    duplicates,
    sessionsRegistered,
    sessionsAdopted,
    foreignSources,
    failedSources: failures.length,
    failures: failures.slice(0, 20),
  };
}
