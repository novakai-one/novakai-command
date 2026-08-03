/**
 * Transcript's durability seam onto Foundation — §8, §18.1.
 *
 * One scoped handle, five kinds: the three carried forward from B2b plus the
 * two B3c adds. Transcript is never granted `quarantine` write scope — it
 * REQUESTS a tombstone and Foundation constructs it (§8), which is what keeps
 * "corruption stops the mirror" from also meaning "Transcript can hide any
 * record it likes".
 */

import {
  b3fail, b3ok, composeHandle, createObject, getObject, isAbsent, listObjects,
  requestQuarantine, storeFailure, updateObject,
  type B3PrincipalId, type B3Result, type ClientOpId, type ObjectId, type ObjectKind,
  type RecordEnvelope, type RecordVersion, type ScopedStoreHandle, type StoredObject,
} from '@novakai/foundation/contract';

/** §18.1's Transcript row: three carried forward, two additive. */
export const TRANSCRIPT_KINDS: readonly ObjectKind[] = [
  'transcriptLine', 'transcriptJournal', 'transcriptCheckpoint',
  'transcriptBinding', 'observedSubagent', 'transcriptTurnCompletion',
];

export interface TranscriptStoreOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly legacyRoot?: string;
  readonly lockTimeoutMs?: number;
}

export type Persisted<T extends RecordEnvelope<string, string>> =
  Omit<T, 'recordVersion' | 'lastMutation'>;

export interface TranscriptStore {
  create<T extends RecordEnvelope<string, string>>(
    payload: Persisted<T> & Record<string, unknown>, clientOpId: ClientOpId,
  ): Promise<B3Result<T>>;

  update<T extends RecordEnvelope<string, string>>(
    id: string, patch: Record<string, unknown>,
    expectedVersion: RecordVersion, clientOpId: ClientOpId,
  ): Promise<B3Result<T>>;

  read<T extends RecordEnvelope<string, string>>(
    kind: ObjectKind, id: string,
  ): Promise<B3Result<T | null>>;

  list<T extends RecordEnvelope<string, string>>(
    kind: ObjectKind, filter?: Record<string, unknown>,
  ): Promise<B3Result<readonly T[]>>;

  /**
   * Ask Foundation to tombstone a corrupt record. Never a direct write.
   *
   * `traceId` is the REQUESTER's correlation (Q10): Foundation writes the
   * tombstone as `sys_foundation` and records who asked next to it, so the
   * §8 grant boundary and the causal audit trail survive together.
   */
  quarantine(
    kind: ObjectKind, id: string, clientOpId: ClientOpId, traceId?: string,
  ): Promise<B3Result<null>>;
}

export function createTranscriptStore(options: TranscriptStoreOptions): TranscriptStore {
  const principal: B3PrincipalId = 'sys_transcript';
  const handle: ScopedStoreHandle = composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: 'transcript',
    allowedKinds: TRANSCRIPT_KINDS,
    principal,
  });

  return {
    async create(payload, clientOpId) {
      const written = await createObject(handle, payload, clientOpId);
      if (!written.ok) return b3fail(storeFailure('transcript', written.error));
      return b3ok(viewOf(written.value));
    },

    async update(id, patch, expectedVersion, clientOpId) {
      const written = await updateObject(
        handle, id as ObjectId, patch, expectedVersion, clientOpId,
      );
      if (!written.ok) return b3fail(storeFailure('transcript', written.error));
      return b3ok(viewOf(written.value));
    },

    async read(kind, id) {
      const stored = await getObject(handle, kind, id as ObjectId);
      if (!stored.ok) return b3fail(storeFailure('transcript', stored.error));
      if (isAbsent(stored.value)) return b3ok(null);
      return b3ok(viewOf(stored.value));
    },

    async list(kind, filter) {
      const page = await listObjects(handle, kind, filter, { limit: 100_000 });
      if (!page.ok) return b3fail(storeFailure('transcript', page.error));
      return b3ok(page.value.items.map((item) => viewOf(item)));
    },

    async quarantine(kind, id, clientOpId, traceId) {
      const requested = await requestQuarantine(handle, {
        target: { kind, id }, clientOpId,
        ...(traceId === undefined ? {} : { traceId }),
      });
      if (!requested.ok) return b3fail(storeFailure('transcript', requested.error));
      return b3ok(null);
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
