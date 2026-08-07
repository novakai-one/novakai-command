import {
  b3err, b3fail, b3ok, canonicalRequestHash, deriveClientOpId, deterministicId,
  type B3Result, type RecordEnvelope,
} from '@novakai/foundation/contract';
import type { RunEvent } from '../contract/runs-api.js';
import type { RunUsageFacts } from '../../supervision/contract/index.js';
import {
  FINAL_LIFECYCLES, type AgentRun, type RunOperation,
} from '../contract/runs.js';
import type { Persisted, RunsStore } from './runs-store.js';

interface RetainedRunOccurrenceEvent
  extends RecordEnvelope<string, 'runOccurrenceEvent'> {
  readonly eventId: string;
  readonly eventKind: string;
  readonly occurredAt: RunEvent['occurredAt'];
  readonly committedAt: RunEvent['committedAt'];
  readonly sourceOwner: RunEvent['sourceOwner'];
  readonly traceId: RunEvent['traceId'];
  readonly cursor: RunEvent['cursor'];
  readonly payload: RunEvent['payload'];
  readonly canonicalPayloadDigest: string;
  readonly runFacts?: RunUsageFacts;
  readonly canonicalEvidenceDigest: string;
}

export interface RetainedRunEvent {
  readonly event: RunEvent;
  readonly runFacts?: RunUsageFacts;
}

const recordId = (eventId: string): string => deterministicId(
  'runOccurrenceEvent', ['retained-runtime-event-v1', eventId],
);

const eventOf = (record: RetainedRunOccurrenceEvent): RunEvent => ({
  eventId: record.eventId,
  kind: record.eventKind,
  schemaVersion: 1,
  occurredAt: record.occurredAt,
  committedAt: record.committedAt,
  sourceOwner: record.sourceOwner,
  traceId: record.traceId,
  cursor: record.cursor,
  payload: record.payload,
});

const usageFacts = (agentRun: AgentRun): RunUsageFacts => ({
  agentRunId: agentRun.id,
  agentId: agentRun.agentId,
  providerSessionId: agentRun.providerSessionId,
  lifecycle: agentRun.lifecycle,
  final: FINAL_LIFECYCLES.has(agentRun.lifecycle),
  activityGeneration: agentRun.activityGeneration,
  recordVersion: agentRun.recordVersion,
});

async function resolveEventRunId(
  store: RunsStore,
  event: RunEvent,
): Promise<B3Result<string | undefined>> {
  const directRunId = event.payload['agentRunId'];
  if (typeof directRunId === 'string') return b3ok(directRunId);
  if (event.kind !== 'agent.run.operation.stage.changed') return b3ok(undefined);
  const operationId = event.payload['operationId'];
  if (typeof operationId !== 'string') return b3ok(undefined);
  const operation = await store.read<RunOperation>('runOperation', operationId);
  if (!operation.ok || operation.value === null) {
    return operation.ok ? b3ok(undefined) : operation;
  }
  const targets = [...new Set([operation.value.oldRunId, operation.value.newRunId]
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined))];
  return b3ok(targets.length === 1 ? targets[0] : undefined);
}

async function snapshotRunFacts(
  store: RunsStore,
  event: RunEvent,
): Promise<B3Result<RunUsageFacts | undefined>> {
  const agentRunId = await resolveEventRunId(store, event);
  if (!agentRunId.ok || agentRunId.value === undefined) {
    return agentRunId.ok ? b3ok(undefined) : agentRunId;
  }
  const storedRun = await store.read<AgentRun>('agentRun', agentRunId.value);
  return storedRun.ok
    ? b3ok(storedRun.value === null ? undefined : usageFacts(storedRun.value))
    : storedRun;
}

function corruption(eventId: string, reason: string): ReturnType<typeof b3err> {
  return b3err(
    'RecoveryRequired',
    `retained Runtime occurrence event ${eventId} is corrupt: ${reason}`,
    { stage: 'occurrence-derivation', eventId, reason },
    true,
  );
}

function matchesRetainedEvidence(
  record: RetainedRunOccurrenceEvent,
  event: RunEvent,
  payloadDigest: string,
  evidenceDigest: string,
): boolean {
  return record.eventId === event.eventId
    && record.canonicalPayloadDigest === payloadDigest
    && canonicalRequestHash(record.payload) === payloadDigest
    && record.canonicalEvidenceDigest === evidenceDigest;
}

/** Persist the exact public event before any consumer can observe it. */
export async function retainRunOccurrenceEvent(
  store: RunsStore,
  event: RunEvent,
): Promise<B3Result<null>> {
  const id = recordId(event.eventId);
  const digest = canonicalRequestHash(event.payload);
  const snapshot = await snapshotRunFacts(store, event);
  if (!snapshot.ok) return snapshot;
  const evidenceDigest = canonicalRequestHash({
    event: { ...event, payload: event.payload },
    runFacts: snapshot.value ?? null,
  });
  const prior = await store.read<RetainedRunOccurrenceEvent>('runOccurrenceEvent', id);
  if (!prior.ok) return prior;
  if (prior.value !== null) {
    return matchesRetainedEvidence(prior.value, event, digest, evidenceDigest)
      ? b3ok(null)
      : b3fail(corruption(event.eventId, 'duplicate identity has different payload facts'));
  }
  const record: Persisted<RetainedRunOccurrenceEvent> & Record<string, unknown> = {
    id,
    kind: 'runOccurrenceEvent',
    schemaVersion: 1,
    createdAt: event.committedAt,
    permissionLevel: 'team',
    createdBy: 'sys_agent_runtime',
    eventId: event.eventId,
    eventKind: event.kind,
    occurredAt: event.occurredAt,
    committedAt: event.committedAt,
    sourceOwner: event.sourceOwner,
    traceId: event.traceId,
    cursor: event.cursor,
    payload: event.payload,
    canonicalPayloadDigest: digest,
    ...(snapshot.value === undefined ? {} : { runFacts: snapshot.value }),
    canonicalEvidenceDigest: evidenceDigest,
  };
  const written = await store.create<RetainedRunOccurrenceEvent>(
    'sys_agent_runtime', record,
    deriveClientOpId(`b3v4:retain-runtime-event:${event.eventId}`),
  );
  if (written.ok) return b3ok(null);
  const raced = await store.read<RetainedRunOccurrenceEvent>('runOccurrenceEvent', id);
  if (!raced.ok || raced.value === null) return written;
  return matchesRetainedEvidence(raced.value, event, digest, evidenceDigest)
    ? b3ok(null)
    : b3fail(corruption(event.eventId, 'competing append has different payload facts'));
}

/** Exact durable lookup, including duplicate-ID/different-payload detection. */
export async function findRetainedRunOccurrenceEvent(
  store: RunsStore,
  eventId: string,
): Promise<B3Result<RetainedRunEvent | null>> {
  const records = await store.list<RetainedRunOccurrenceEvent>(
    'runOccurrenceEvent', { eventId },
  );
  if (!records.ok) return records;
  if (records.value.length === 0) return b3ok(null);
  const canonical = records.value[0]!;
  const digest = canonical.canonicalPayloadDigest;
  const evidenceDigest = canonical.canonicalEvidenceDigest;
  for (const candidate of records.value) {
    if (candidate.eventId !== eventId
      || candidate.canonicalPayloadDigest !== digest
      || candidate.canonicalEvidenceDigest !== evidenceDigest
      || canonicalRequestHash(candidate.payload) !== candidate.canonicalPayloadDigest
      || canonicalRequestHash({
        event: eventOf(candidate), runFacts: candidate.runFacts ?? null,
      }) !== candidate.canonicalEvidenceDigest) {
      return b3fail(corruption(eventId, 'duplicate event IDs disagree on canonical payload'));
    }
  }
  return b3ok({
    event: eventOf(canonical),
    ...(canonical.runFacts === undefined ? {} : { runFacts: canonical.runFacts }),
  });
}
