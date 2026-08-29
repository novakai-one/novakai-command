import type {
  IngestResult,
  IngestSourceFailure,
} from "../../contract/runtime.js";
import type {
  ProviderNormalizer,
  ProviderSourceStat,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type { ProviderSession } from "../../contract/records/provider-session.js";
import type { ProviderName, Timestamp } from "../../contract/types.js";
import type { AgentDirectory } from "../../contract/ports/agent-directory.js";
import { confirmPendingSends } from "../send/confirm.js";
import { present } from "../send/sparse.js";
import {
  classifyProviderSession,
  type EvidenceRejection,
  type ExternalAdoptionRuntimePolicy,
  type SessionClassification,
} from "./classify-session.js";
import { prepareSource, type PreparedSource } from "./prepare-source.js";
import { failureFor } from "./source-failure.js";
import type { IngestionStore } from "./ingest-store.js";
import {
  ingestCheckpointFor,
  transcriptLineFor,
} from "./ingest-records.js";
import { selectSourcesForIngest } from './select-sources.js';

interface IngestionDependencies {
  readonly store: IngestionStore;
  readonly source: Pick<ProviderTranscriptSource, 'scan' | 'readGrowth'>;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly now: () => Timestamp;
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
  readonly failure?: IngestSourceFailure;
}

/** One pass's running tally; folded per source, reported at the end. */
interface PassTally {
  added: number;
  duplicates: number;
  sessionsRegistered: number;
  sessionsAdopted: number;
  foreignSources: number;
  readonly failures: IngestSourceFailure[];
}

/** Failure detail reported to hosts is capped; the count always reflects every failure. */
const MAX_REPORTED_FAILURES = 20;

const emptySourceResult = (): SourceIngestResult => ({
  added: 0,
  duplicates: 0,
  registered: 0,
  adopted: false,
  foreign: false,
});

const emptyPassTally = (): PassTally => ({
  added: 0,
  duplicates: 0,
  sessionsRegistered: 0,
  sessionsAdopted: 0,
  foreignSources: 0,
  failures: [],
});

/**
 * Runs one ingestion pass: stat the provider sources, select the ones worth
 * reading, then per selected source read its growth, normalize the new bytes
 * into transcript records, and commit them as one batch. Without candidates it
 * requests full source discovery; with candidates it skips discovery and
 * processes only those sources. One source failing never blocks the others:
 * the failure is caught, given a typed kind, and reported in the result.
 *
 * Crash recovery: a pass that dies mid-source leaves that source's checkpoint
 * unmoved, so the next pass re-reads it and line-id dedupe keeps the recommit
 * safe. Store and provider failures outside per-source work throw; the
 * runtime door (messaging-runtime.ts) maps them to a retryable
 * DependencyUnavailable outcome.
 */
export async function runIngestionPass(
  dependencies: IngestionDependencies,
  candidates?: readonly ProviderSourceStat[],
): Promise<IngestResult> {
  const scanned = candidates ?? await dependencies.source.scan();
  const sessions = [...await dependencies.store.listProviderSessions()];
  const sources = await selectSourcesForIngest({
    sources: scanned,
    sessions,
    journals: await dependencies.store.listSendJournals(),
    discoveryFloor: dependencies.discoveryFloor,
    ...present('directory', dependencies.agentDirectory),
  });
  const tally = emptyPassTally();
  const adoptionBudget = { remaining: dependencies.adoption?.limitPerTick ?? 0 };
  for (const source of sources) {
    const result = await ingestOneSafely(dependencies, source, sessions, adoptionBudget);
    foldSourceResult(tally, result);
    rememberSession(sessions, result.session);
  }
  await confirmPendingSends(dependencies.store, dependencies.now());
  return {
    sources: sources.length,
    added: tally.added,
    duplicates: tally.duplicates,
    sessionsRegistered: tally.sessionsRegistered,
    sessionsAdopted: tally.sessionsAdopted,
    foreignSources: tally.foreignSources,
    failedSources: tally.failures.length,
    failures: tally.failures.slice(0, MAX_REPORTED_FAILURES),
  };
}

/** One source failing never blocks the others — the throw is caught and typed here. */
async function ingestOneSafely(
  dependencies: IngestionDependencies,
  source: ProviderSourceStat,
  sessions: ProviderSession[],
  adoptionBudget: { remaining: number },
): Promise<SourceIngestResult> {
  try {
    return await ingestSource(dependencies, source, sessions, adoptionBudget);
  } catch (cause) {
    return { ...emptySourceResult(), failure: failureFor(source, cause) };
  }
}

/** Folds one source's outcome into the pass tally. */
function foldSourceResult(tally: PassTally, result: SourceIngestResult): void {
  tally.added += result.added;
  tally.duplicates += result.duplicates;
  tally.sessionsRegistered += result.registered;
  if (result.adopted) tally.sessionsAdopted += 1;
  if (result.foreign) tally.foreignSources += 1;
  if (result.failure !== undefined) tally.failures.push(result.failure);
}

/** Remembers the session a source produced so later sources this pass see it. */
function rememberSession(sessions: ProviderSession[], session: ProviderSession | undefined): void {
  if (session === undefined) return;
  const current = sessions.findIndex((candidate) => candidate.id === session.id);
  if (current < 0) sessions.push(session);
  else sessions[current] = session;
}

/**
 * Ingests one selected source: prepare, classify the session the evidence
 * points to, then settle that decision into writes.
 */
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
    ...present('storeId', dependencies.storeId),
    ...present('directory', dependencies.agentDirectory),
    ...present('adoption', dependencies.adoption),
  });
  return settleClassification(dependencies, source, prepared, classification, adoptionBudget);
}

/**
 * Turns one classification into writes: a rejection fails the source with
 * typed evidence, a deferral registers it metadata-only, and a commit
 * batches its lines. An adoption spends one unit of the per-tick budget.
 */
async function settleClassification(
  dependencies: IngestionDependencies,
  source: ProviderSourceStat,
  prepared: PreparedSource,
  classification: SessionClassification,
  adoptionBudget: { remaining: number },
): Promise<SourceIngestResult> {
  if (classification.kind === 'reject') return rejectedSource(source, classification);
  if (classification.kind === 'defer') {
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

/** A rejected source fails this pass with its typed evidence; nothing is written. */
const rejectedSource = (
  source: ProviderSourceStat,
  rejection: EvidenceRejection,
): SourceIngestResult => ({
  ...emptySourceResult(),
  failure: {
    sourceId: source.sourceId,
    provider: source.provider,
    kind: rejection.failure,
    message: rejection.message,
  },
});

/** A source registers its session only when the session is new to the store. */
const registrationCount = (existing: ProviderSession | undefined): number =>
  existing === undefined ? 1 : 0;

/** Commits one prepared source's lines and advanced checkpoint as one batch. */
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
    registered: registrationCount(existing),
    session,
    adopted,
    foreign: false,
  };
}

/**
 * Registers a session without publishing its lines: the source is remembered
 * so later passes can reclassify it, but its bytes stay invisible until it is
 * adopted or assigned.
 */
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
    registered: registrationCount(existing),
    session,
    foreign,
  };
}
