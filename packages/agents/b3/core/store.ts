// Agents' durability seam onto Foundation (AMD-001 A-01).
//
// One scoped handle, six kinds, no JSONL file opened anywhere. The handle is
// composed per authenticated principal so Foundation stamps the real caller
// into `createdBy` — a request body can never claim authorship (red gate 5).
import {
  b3err, b3fail, b3ok, composeHandle, createObject, getObject, isAbsent,
  listObjects, storeFailure, updateObject,
  type B3PrincipalId, type B3Result, type ClientOpId, type ObjectId, type ObjectKind,
  type RecordEnvelope, type RecordVersion, type ScopedStoreHandle, type StoredObject,
} from '@novakai/foundation/contract';

/**
 * `agent` and `providerSession` are carried forward — Agents already owned
 * them. The other five are B3b's additive registrations. Agents writes these
 * and nothing else (§3.3).
 */
export const GOVERNED_AGENT_KINDS: readonly ObjectKind[] = [
  'agent', 'providerSession', 'providerSessionHandle',
  'agentRoleProfile', 'resolvedLaunchPlan', 'agentRelationship',
  'delegationGrant', 'controlReplacementPlan',
];

export interface GovernedAgentsStoreOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly legacyRoot?: string;
  readonly lockTimeoutMs?: number;
}

/** A record as persisted: the public view minus the two derived fields. */
export type Persisted<T extends RecordEnvelope<string, string>> =
  Omit<T, 'recordVersion' | 'lastMutation'>;

export interface GovernedAgentsStore {
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

export function createGovernedAgentsStore(
  options: GovernedAgentsStoreOptions,
): GovernedAgentsStore {
  const handleFor = (principal: B3PrincipalId): ScopedStoreHandle => composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: 'agents',
    allowedKinds: GOVERNED_AGENT_KINDS,
    principal,
  });
  const reader = handleFor('sys_agents');

  return {
    async create(principal, payload, clientOpId) {
      const written = await createObject(handleFor(principal), payload, clientOpId);
      if (!written.ok) return b3fail(storeFailure('agents', written.error));
      return b3ok(viewOf(written.value));
    },

    async update(principal, id, patch, expectedVersion, clientOpId) {
      const written = await updateObject(
        handleFor(principal), id as ObjectId, patch, expectedVersion, clientOpId,
      );
      if (!written.ok) return b3fail(storeFailure('agents', written.error));
      return b3ok(viewOf(written.value));
    },

    async read(kind, id) {
      const stored = await getObject(reader, kind, id as ObjectId);
      if (!stored.ok) return b3fail(storeFailure('agents', stored.error));
      if (isAbsent(stored.value)) return b3ok(null);
      return b3ok(viewOf(stored.value));
    },

    async list(kind, filter) {
      const page = await listObjects(reader, kind, filter, { limit: 100_000 });
      if (!page.ok) return b3fail(storeFailure('agents', page.error));
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

export const unknownAgent = (agentId: string): ReturnType<typeof b3err> =>
  b3err('UnknownAgent', `no agent "${agentId}"`, { agentId }, false);

export const roleNotAllowed = (
  roleProfileId: string, reason: string, parentAgentId?: string,
): ReturnType<typeof b3err> => b3err('RoleNotAllowed', reason,
  { roleProfileId, ...(parentAgentId === undefined ? {} : { parentAgentId }) }, false);

export const launchPlanInvalid = (
  issues: ReadonlyArray<{ path: string; message: string }>,
): ReturnType<typeof b3err> => b3err('LaunchPlanInvalid',
  `launch plan rejected: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
  { issues }, false);
