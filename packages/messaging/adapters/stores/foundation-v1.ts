/**
 * Messaging durability on Foundation's one engine — B3V4-P2 §8, §18.1.
 *
 * This is the adapter the amendment asked for, and its whole job is small:
 * take the StoreOp the existing StoreCore already produces, wrap it as ONE
 * immutable `messagingStoreOp` Foundation record, and append it before the
 * operation is applied in memory. StoreCore stays the sole serialiser; the
 * atomic StoreOp boundary that Messaging has always had is preserved exactly.
 *
 * What this replaces is `store-jsonl` — a second JSONL writer with its own
 * line format, its own torn-tail recovery, its own fsync discipline. After
 * cutover that route is disabled in production and survives only in tests.
 *
 * What it deliberately does NOT do is spread Messaging's entities across
 * Foundation kinds. §18.1 is explicit: Message, Thread, Delivery, acceptance,
 * endpoint claim and inbox item remain entities inside the operation payload.
 * One StoreOp is one atomic Foundation append, so `commitAcceptance` still
 * commits Thread/Message/snapshot/Delivery/acceptance/inbox/journal together.
 */

import {
  composeHandle, createObject, deriveClientOpId, getObject, isAbsent,
  listObjects, mintMessagingStoreOpId,
  type ObjectId, type ScopedStoreHandle, type StoredObject,
} from "@novakai/foundation/contract";
import { StoreCore, StoreException, storeOpNames } from "../store-shared.js";
import type { StoreOp } from "../store-shared.js";
import { digestOf, operationKeyOf } from "../store-operation-identity.js";
import type { ClockIds } from "../../contract/ports/clock.js";
import type { MessagingStore } from "../../contract/ports/store.js";
import type { MessagingStoreOpId } from "../../contract/records/legacy-agent-mail.js";
import { acquireMessagingWriterLease } from './writer-lease.js';

/** Foundation roots and lock policy used by the v1 replay adapter. */
export interface FoundationMessagingStoreOptions {
  /** `.novakai/` root — the lock lives here. */
  readonly root: string;
  /** JSONL directory. Production passes `<root>/stores` (§18.1). */
  readonly dataRoot?: string;
  readonly legacyRoot?: string;
  readonly lockTimeoutMs?: number;
}

/** The persisted payload of one `messagingStoreOp` record (§8.1). */
export interface MessagingStoreOpPayload {
  readonly kind: "messagingStoreOp";
  readonly id: MessagingStoreOpId;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly permissionLevel: "private";
  readonly createdBy: string;
  /** Monotonic across EVERY StoreOp. Replay sorts by it (§8.1). */
  readonly storeSequence: number;
  /** The stable logical key for this StoreOp variant. */
  readonly operationKey: string;
  readonly payloadDigest: string;
  readonly storeOp: StoreOp;
}

interface PersistenceState {
  storeSequence: number;
  readonly seenKeys: Set<string>;
}

function messagingHandle(options: FoundationMessagingStoreOptions): ScopedStoreHandle {
  return composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: "messaging",
    allowedKinds: ["messagingStoreOp"],
    principal: "sys_messaging",
  });
}

function replay(
  core: StoreCore,
  persisted: readonly StoredObject<MessagingStoreOpPayload>[],
): PersistenceState {
  const records = persisted.map((item) => item.object)
    .sort((left, right) => left.storeSequence - right.storeSequence);
  const state: PersistenceState = { storeSequence: 0, seenKeys: new Set() };
  for (const record of records) {
    core.applyOp(record.storeOp);
    state.seenKeys.add(record.operationKey);
    state.storeSequence = Math.max(state.storeSequence, record.storeSequence);
  }
  return state;
}

function legacyPayload(value: unknown): MessagingStoreOpPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<MessagingStoreOpPayload>;
  const operation = record.storeOp as { op?: unknown } | undefined;
  return record.kind === 'messagingStoreOp'
    && typeof record.storeSequence === 'number'
    && typeof record.operationKey === 'string'
    && typeof record.payloadDigest === 'string'
    && typeof operation?.op === 'string'
    && (storeOpNames as readonly string[]).includes(operation.op)
    ? record as MessagingStoreOpPayload : undefined;
}

function payloadFor(
  clock: ClockIds,
  state: PersistenceState,
  operation: StoreOp,
  operationKey: string,
  payloadDigest: string,
): MessagingStoreOpPayload {
  return {
    kind: "messagingStoreOp",
    id: mintMessagingStoreOpId(operationKey) as string as MessagingStoreOpId,
    schemaVersion: 1,
    createdAt: clock.now(),
    permissionLevel: "private",
    createdBy: "overridden-by-foundation",
    storeSequence: state.storeSequence,
    operationKey,
    payloadDigest,
    storeOp: operation,
  };
}

async function persistOperation(
  handle: ScopedStoreHandle,
  clock: ClockIds,
  state: PersistenceState,
  operation: StoreOp,
): Promise<void> {
  const operationKey = operationKeyOf(operation);
  const payloadDigest = digestOf(operation);
  const id = mintMessagingStoreOpId(operationKey) as string as MessagingStoreOpId;
  if (state.seenKeys.has(operationKey)) {
    const existing = await getExisting(handle, id);
    if (existing !== null && existing.payloadDigest !== payloadDigest) {
      throw new StoreException({
        name: "StoreCorrupt",
        message: `messagingStoreOp ${operationKey} already exists with a different payload`,
      });
    }
    return;
  }

  state.storeSequence += 1;
  const payload = payloadFor(clock, state, operation, operationKey, payloadDigest);
  const written = await createObject(
    handle,
    payload as unknown as Record<string, unknown> & {
      kind: string; id: string; schemaVersion: number; createdAt: string;
      permissionLevel: "private"; createdBy: string;
    },
    deriveClientOpId(`messagingStoreOp:${operationKey}`),
  );
  if (!written.ok) {
    state.storeSequence -= 1;
    throw new StoreException({
      name: "StoreUnavailable",
      message: `messagingStoreOp append failed: ${written.error.code} ${written.error.message}`,
      retryable: true,
    });
  }
  state.seenKeys.add(operationKey);
}

/**
 * Open Messaging's production store.
 *
 * Open replays every persisted operation in `storeSequence` order into a fresh
 * StoreCore, then attaches the append-before-apply hook. A crash between a
 * Foundation append and the in-memory apply is therefore recovered by exactly
 * this replay — the append is the durable fact, the memory is a projection.
 */
export async function openFoundationMessagingStore(
  clock: ClockIds,
  options: FoundationMessagingStoreOptions,
): Promise<MessagingStore> {
  const lease = await acquireMessagingWriterLease(options.root, 'messaging-v1');
  try {
  const handle = messagingHandle(options);
  const core = new StoreCore(clock);
  const persisted = await listObjects<unknown>(
    handle, "messagingStoreOp", undefined, { limit: 1_000_000 },
  );
  if (!persisted.ok) {
    throw new StoreException({
      name: "StoreUnavailable",
      message: `messagingStoreOp replay failed: ${persisted.error.code}`,
      retryable: true,
    });
  }
  const compatible = persisted.value.items.flatMap((item) => {
    const object = legacyPayload(item.object);
    return object === undefined ? [] : [{ ...item, object }];
  });
  const state = replay(core, compatible);
  core.attachPersistence(
    (operation) => persistOperation(handle, clock, state, operation),
    () => lease.release(),
  );
  return core;
  } catch (cause) {
    await lease.release();
    throw cause;
  }
}

async function getExisting(
  handle: ScopedStoreHandle, id: MessagingStoreOpId,
): Promise<MessagingStoreOpPayload | null> {
  const stored = await getObject<MessagingStoreOpPayload>(
    handle, "messagingStoreOp", id as unknown as ObjectId,
  );
  if (!stored.ok || isAbsent(stored.value)) return null;
  return stored.value.object;
}
