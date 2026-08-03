// Agent Runtime's durability seam onto Foundation (AMD-001 A-01).
//
// One scoped handle, five kinds, no JSONL file opened anywhere.
import {
  b3err, b3fail, b3ok, composeHandle, createObject, getObject, isAbsent,
  listObjects, storeFailure, updateObject,
  type B3PrincipalId, type B3Result, type ClientOpId, type ObjectId, type ObjectKind,
  type RecordEnvelope, type RecordVersion, type ScopedStoreHandle, type StoredObject,
} from '@novakai/foundation/contract';

export const RUNTIME_KINDS: readonly ObjectKind[] = [
  'agentRun', 'runContinuation', 'supervisionAssignment',
  'treeMutationFence', 'runOperation', 'runOccurrenceEvent',
];

export interface RunsStoreOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly legacyRoot?: string;
  readonly lockTimeoutMs?: number;
}

export type Persisted<T extends RecordEnvelope<string, string>> =
  Omit<T, 'recordVersion' | 'lastMutation'>;

export interface RunsStore {
  create<T extends RecordEnvelope<string, string>>(
    principal: B3PrincipalId, payload: Persisted<T> & Record<string, unknown>,
    clientOpId: ClientOpId,
  ): Promise<B3Result<T>>;

  update<T extends RecordEnvelope<string, string>>(
    principal: B3PrincipalId, id: string, patch: Record<string, unknown>,
    expectedVersion: RecordVersion, clientOpId: ClientOpId,
  ): Promise<B3Result<T>>;

  read<T extends RecordEnvelope<string, string>>(
    kind: ObjectKind, id: string,
  ): Promise<B3Result<T | null>>;

  list<T extends RecordEnvelope<string, string>>(
    kind: ObjectKind, filter?: Record<string, unknown>,
  ): Promise<B3Result<readonly T[]>>;
}

export function createRunsStore(options: RunsStoreOptions): RunsStore {
  const handleFor = (principal: B3PrincipalId): ScopedStoreHandle => composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: 'agent-runtime',
    allowedKinds: RUNTIME_KINDS,
    principal,
  });
  const reader = handleFor('sys_agent_runtime');

  return {
    async create(principal, payload, clientOpId) {
      const written = await createObject(handleFor(principal), payload, clientOpId);
      if (!written.ok) return b3fail(storeFailure('agent-runtime', written.error));
      return b3ok(viewOf(written.value));
    },

    async update(principal, id, patch, expectedVersion, clientOpId) {
      const written = await updateObject(
        handleFor(principal), id as ObjectId, patch, expectedVersion, clientOpId,
      );
      if (!written.ok) return b3fail(storeFailure('agent-runtime', written.error));
      return b3ok(viewOf(written.value));
    },

    async read(kind, id) {
      const stored = await getObject(reader, kind, id as ObjectId);
      if (!stored.ok) return b3fail(storeFailure('agent-runtime', stored.error));
      if (isAbsent(stored.value)) return b3ok(null);
      return b3ok(viewOf(stored.value));
    },

    async list(kind, filter) {
      const page = await listObjects(reader, kind, filter, { limit: 100_000 });
      if (!page.ok) return b3fail(storeFailure('agent-runtime', page.error));
      return b3ok(page.value.items.map((item) => viewOf(item)));
    },
  };
}

function viewOf<T>(stored: StoredObject<unknown>): T {
  return {
    ...(stored.object as Record<string, unknown>),
    recordVersion: stored.version as RecordVersion,
    lastMutation: stored.lastMutation,
  } as T;
}

export const unknownRun = (agentRunId: string): ReturnType<typeof b3err> =>
  b3err('UnknownAgentRun', `no agent run "${agentRunId}"`, { agentRunId }, false);

export const runFinal = (
  agentRunId: string, lifecycle: string,
): ReturnType<typeof b3err> => b3err('RunFinal',
  `agent run ${agentRunId} is ${lifecycle}`, { agentRunId, lifecycle }, false);

export const liveRunConflict = (
  agentId: string, liveRunId: string,
): ReturnType<typeof b3err> => b3err('LiveRunConflict',
  `agent ${agentId} already has a live run`, { agentId, liveRunId }, false);

export const recoveryRequired = (
  operationId: string, stage: string, reason: string,
): ReturnType<typeof b3err> => b3err('RecoveryRequired',
  `operation ${operationId} stopped at ${stage}: ${reason}`,
  { operationId, stage, reason }, true);
