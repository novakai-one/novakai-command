// The durable epoch record and its compare-and-set advance (DEC-B3V4-27).
//
// One epoch is `active`. Advancing means marking the old one `stale` under CAS
// and appending the new one — so two hosts racing on the same store cannot
// both end up believing they are current.
import {
  b3fail, b3ok, composeHandle, createObject, listObjects, mintClientOpId,
  mintRuntimeEpochId, nowIsoUtc, storeFailure, updateObject,
  type B3Result, type ObjectId, type RecordVersion, type RuntimeEpochId,
  type ScopedStoreHandle, type StoredObject,
} from '@novakai/foundation/contract';
import type { RuntimeEpoch, RuntimeEpochState } from '../contract/index.js';

/** As persisted: the public view minus Foundation's two derived fields. */
type Persisted = Omit<RuntimeEpoch, 'recordVersion' | 'lastMutation'>;

export interface EpochStoreOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly legacyRoot?: string;
  readonly lockTimeoutMs?: number;
}

export interface EpochStore {
  active(): Promise<B3Result<RuntimeEpoch | null>>;
  everyEpoch(): Promise<B3Result<readonly RuntimeEpoch[]>>;
  advance(hostPid: number, hostVersion: string): Promise<B3Result<RuntimeEpoch>>;
  settle(epoch: RuntimeEpoch, state: RuntimeEpochState): Promise<B3Result<RuntimeEpoch>>;
}

export function createEpochStore(options: EpochStoreOptions): EpochStore {
  const handle: ScopedStoreHandle = composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: 'agent-runtime',
    allowedKinds: ['runtimeEpoch'],
    principal: 'sys_agent_runtime',
  });

  async function every(): Promise<B3Result<readonly RuntimeEpoch[]>> {
    const page = await listObjects<RuntimeEpoch>(handle, 'runtimeEpoch', undefined, { limit: 100_000 });
    if (!page.ok) return b3fail(storeFailure('agent-runtime', page.error));
    return b3ok(page.value.items.map((item) => viewOf(item)));
  }

  async function active(): Promise<B3Result<RuntimeEpoch | null>> {
    const known = await every();
    if (!known.ok) return known;
    const live = known.value.filter((epoch) => epoch.state === 'active');
    // Newest wins if a crash ever left two: the caller then supersedes the rest.
    const newest = live.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    return b3ok(newest ?? null);
  }

  async function settle(
    epoch: RuntimeEpoch, state: RuntimeEpochState, supersededBy?: RuntimeEpochId,
  ): Promise<B3Result<RuntimeEpoch>> {
    const written = await updateObject<RuntimeEpoch>(
      handle, epoch.id as unknown as ObjectId,
      {
        state, endedAt: nowIsoUtc(),
        ...(supersededBy === undefined ? {} : { supersededByEpochId: supersededBy }),
      },
      epoch.recordVersion, mintClientOpId(),
    );
    if (!written.ok) return b3fail(storeFailure('agent-runtime', written.error));
    return b3ok(viewOf(written.value));
  }

  return {
    everyEpoch: every,
    active,
    settle: (epoch, state) => settle(epoch, state),

    async advance(hostPid: number, hostVersion: string) {
      const known = await every();
      if (!known.ok) return known;
      const nextId = mintRuntimeEpochId();
      // CAS every currently-active epoch to stale FIRST. A losing CAS means
      // another host advanced underneath us; the caller re-reads and converges.
      for (const epoch of known.value.filter((item) => item.state === 'active')) {
        const superseded = await settle(epoch, 'stale', nextId);
        if (!superseded.ok) return superseded;
      }
      const created = await createObject<Persisted>(handle, {
        kind: 'runtimeEpoch', id: nextId, schemaVersion: 1,
        createdAt: nowIsoUtc(), permissionLevel: 'private',
        createdBy: 'sys_agent_runtime',
        state: 'active', hostPid, hostVersion, startedAt: nowIsoUtc(),
      }, mintClientOpId());
      if (!created.ok) return b3fail(storeFailure('agent-runtime', created.error));
      return b3ok(viewOf(created.value));
    },
  };
}

function viewOf(stored: StoredObject<unknown>): RuntimeEpoch {
  return {
    ...(stored.object as Record<string, unknown>),
    recordVersion: stored.version as RecordVersion,
    lastMutation: stored.lastMutation,
  } as RuntimeEpoch;
}
