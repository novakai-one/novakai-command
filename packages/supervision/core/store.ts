// Supervision's durability seam onto Foundation (§18.1, AMD-001 A-01).
//
// One scoped handle, three kinds, no JSONL file opened anywhere. Deliberately
// the same shape Agent Runtime uses: a capability that invents its own
// persistence is a capability that leaves the one-writer law unenforceable.
import {
  b3fail, b3ok, composeHandle, createObject, getObject, isAbsent,
  listObjects, storeFailure, updateObject,
  type B3PrincipalId, type B3Result, type ClientOpId, type ObjectId, type ObjectKind,
  type RecordEnvelope, type RecordVersion, type ScopedStoreHandle, type StoredObject,
} from '@novakai/foundation/contract';

/** The three §18.1 rows Supervision owns, and the only kinds it may write. */
export const SUPERVISION_KINDS: readonly ObjectKind[] = [
  'watchRule', 'watchDeadline', 'notification',
];

export interface SupervisionStoreOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly lockTimeoutMs?: number;
}

export type Persisted<Record_ extends RecordEnvelope<string, string, number>> =
  Omit<Record_, 'recordVersion' | 'lastMutation'>;

export interface SupervisionStore {
  create<Record_ extends RecordEnvelope<string, string, number>>(
    principal: B3PrincipalId,
    payload: Persisted<Record_> & Record<string, unknown>,
    clientOpId: ClientOpId,
  ): Promise<B3Result<Record_>>;

  update<Record_ extends RecordEnvelope<string, string, number>>(
    principal: B3PrincipalId, objectId: string, patch: Record<string, unknown>,
    expectedVersion: RecordVersion, clientOpId: ClientOpId,
  ): Promise<B3Result<Record_>>;

  read<Record_ extends RecordEnvelope<string, string, number>>(
    kind: ObjectKind, objectId: string,
  ): Promise<B3Result<Record_ | null>>;

  list<Record_ extends RecordEnvelope<string, string, number>>(
    kind: ObjectKind, filter?: Record<string, unknown>,
  ): Promise<B3Result<readonly Record_[]>>;
}

export function createSupervisionStore(options: SupervisionStoreOptions): SupervisionStore {
  const handleFor = (principal: B3PrincipalId): ScopedStoreHandle => composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: 'supervision',
    allowedKinds: SUPERVISION_KINDS,
    principal,
  });
  const reader = handleFor('sys_supervision');

  return {
    async create(principal, payload, clientOpId) {
      const written = await createObject(handleFor(principal), payload, clientOpId);
      if (!written.ok) return b3fail(storeFailure('supervision', written.error));
      return b3ok(viewOf(written.value));
    },

    async update(principal, objectId, patch, expectedVersion, clientOpId) {
      const written = await updateObject(
        handleFor(principal), objectId as ObjectId, patch, expectedVersion, clientOpId,
      );
      if (!written.ok) return b3fail(storeFailure('supervision', written.error));
      return b3ok(viewOf(written.value));
    },

    async read(kind, objectId) {
      const stored = await getObject(reader, kind, objectId as ObjectId);
      if (!stored.ok) return b3fail(storeFailure('supervision', stored.error));
      if (isAbsent(stored.value)) return b3ok(null);
      return b3ok(viewOf(stored.value));
    },

    async list(kind, filter) {
      const page = await listObjects(reader, kind, filter, { limit: 100_000 });
      if (!page.ok) return b3fail(storeFailure('supervision', page.error));
      return b3ok(page.value.items.map((item) => viewOf(item)));
    },
  };
}

function viewOf<Record_>(stored: StoredObject<unknown>): Record_ {
  return {
    ...(stored.object as Record<string, unknown>),
    recordVersion: stored.version as RecordVersion,
    lastMutation: stored.lastMutation,
  } as Record_;
}
