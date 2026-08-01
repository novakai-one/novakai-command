// Terminal's durability seam onto Foundation (AMD-001 A-01).
//
// One scoped handle, four kinds, no JSONL file ever opened here. The handle is
// composed per authenticated principal so `createdBy` is the real caller —
// Foundation stamps it from the handle, never from the request (red gate 5).
import {
  composeHandle, createObject, getObject, isAbsent, listObjects, updateObject,
  storeFailure, b3ok, b3err,
  type B3PrincipalId, type B3Result, type ClientOpId, type ObjectId, type ObjectKind,
  type RecordEnvelope, type RecordVersion, type ScopedStoreHandle, type StoredObject,
} from '@novakai/foundation/contract';

export const TERMINAL_KINDS: readonly ObjectKind[] = [
  'terminalSession', 'controllerAttachment', 'terminalInputLease', 'terminalInputAttempt',
];

export interface TerminalStoreOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly legacyRoot?: string;
  readonly lockTimeoutMs?: number;
}

/** A record as it is persisted: the public view minus the two derived fields. */
export type Persisted<T extends RecordEnvelope<string, string>> =
  Omit<T, 'recordVersion' | 'lastMutation'>;

export interface TerminalStore {
  create<T extends RecordEnvelope<string, string>>(
    principal: B3PrincipalId, payload: Persisted<T>, clientOpId: ClientOpId,
  ): Promise<B3Result<T>>;

  update<T extends RecordEnvelope<string, string>>(
    principal: B3PrincipalId, kind: ObjectKind, id: string,
    patch: Partial<Persisted<T>>, expectedVersion: RecordVersion, clientOpId: ClientOpId,
  ): Promise<B3Result<T>>;

  read<T extends RecordEnvelope<string, string>>(
    kind: ObjectKind, id: string,
  ): Promise<B3Result<T | null>>;

  list<T extends RecordEnvelope<string, string>>(
    kind: ObjectKind, filter?: Record<string, unknown>,
  ): Promise<B3Result<readonly T[]>>;
}

export function createTerminalStore(options: TerminalStoreOptions): TerminalStore {
  const handleFor = (principal: B3PrincipalId): ScopedStoreHandle => composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: 'terminal',
    allowedKinds: TERMINAL_KINDS,
    principal,
  });
  const reader = handleFor('sys_terminal');

  return {
    async create(principal, payload, clientOpId) {
      const written = await createObject(handleFor(principal), payload, clientOpId);
      if (!written.ok) return { ok: false, error: storeFailure('terminal', written.error) };
      return b3ok(viewOf(written.value));
    },

    async update(principal, kind, id, patch, expectedVersion, clientOpId) {
      const written = await updateObject(
        handleFor(principal), id as ObjectId, patch, expectedVersion, clientOpId,
      );
      if (!written.ok) return { ok: false, error: storeFailure('terminal', written.error) };
      return b3ok(viewOf(written.value));
    },

    async read(kind, id) {
      const stored = await getObject(reader, kind, id as ObjectId);
      if (!stored.ok) return { ok: false, error: storeFailure('terminal', stored.error) };
      if (isAbsent(stored.value)) return b3ok(null);
      return b3ok(viewOf(stored.value));
    },

    async list(kind, filter) {
      const page = await listObjects(reader, kind, filter, { limit: 100_000 });
      if (!page.ok) return { ok: false, error: storeFailure('terminal', page.error) };
      return b3ok(page.value.items.map((item) => viewOf(item)));
    },
  };
}

/**
 * Foundation's stored shape → the public record view. `recordVersion` comes
 * from `meta.version` and `lastMutation` from Foundation's provenance; neither
 * is ever persisted as a competing envelope field (§4.3).
 */
function viewOf<T>(stored: StoredObject<unknown>): T {
  return {
    ...(stored.object as Record<string, unknown>),
    recordVersion: stored.version as RecordVersion,
    lastMutation: stored.lastMutation,
  } as T;
}

export function unknownSession(terminalSessionId: string): ReturnType<typeof b3err> {
  return b3err('UnknownTerminalSession', `no terminal session "${terminalSessionId}"`,
    { terminalSessionId }, false);
}
