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
  canonicalJson, composeHandle, createObject, deriveClientOpId, getObject, isAbsent,
  listObjects, mintMessagingStoreOpId,
  type ObjectId, type ScopedStoreHandle, type StoredObject,
} from "@novakai/foundation/contract";
import { createHash } from "node:crypto";

import { StoreCore, StoreException } from "../../adapters/store-shared.js";
import type { StoreOp } from "../../adapters/store-shared.js";
import type { ClockIds } from "../../seams/clock.js";
import type { MessagingStore } from "../../seams/store.js";
import type { MessagingStoreOpId } from "../contract/records.js";

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

/**
 * The stable logical key for one StoreOp (§8.1).
 *
 * "Stable" means: the same logical operation, retried after a crash, produces
 * the same key. That is what lets the retry find its own record instead of
 * appending a second one. Where a variant can legitimately happen more than
 * once for the same entity (a Delivery moving pending → delivered → failed),
 * the key includes the journal sequence that made it distinct.
 */
export function operationKeyOf(op: StoreOp): string {
  switch (op.op) {
    case "acceptance":
      return `acceptance:${op.message.id}`;
    case "room-thread":
      return `room-thread:${op.thread.id}`;
    case "delivery-transition":
      return `delivery-transition:${op.delivery.id}:${op.journal.sequence}`;
    case "attempt":
      return `attempt:${op.attempt.id}`;
    case "policy":
      return `policy:${op.contact?.personId ?? op.dnd?.personId ?? "?"}:${op.journal.sequence}`;
    case "template":
      return `template:${op.template.id}:${op.journal.sequence}`;
    case "settled":
      return `settled:${op.messageId}`;
    // B3c: the TARGET STATE is what makes reserved → active → draining three
    // operations rather than one overwritten three times. The entity revision
    // would have looked like the same thing and been wrong: a revision is
    // derived from what is already stored, so a crash-and-retry of one logical
    // transition computes revision+1 and becomes a SECOND record. Keying on the
    // state each transition moves to makes the retry land on its own record,
    // which is the whole point of an idempotency key.
    case "agent-endpoint-claim":
      return `agent-endpoint-claim:${op.claim.id}:${op.claim.state}`;
    case "agent-inbox-transition":
      return `agent-inbox-transition:${op.item.id}:${op.item.state}`;
    case "agent-endpoint-transfer":
      return `agent-endpoint-transfer:${op.oldClaim.id}->${op.newClaim.id}`;
  }
}

export const digestOf = (op: StoreOp): string =>
  createHash("sha256").update(canonicalJson(op), "utf8").digest("hex");

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
  const handle: ScopedStoreHandle = composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: "messaging",
    allowedKinds: ["messagingStoreOp"],
    principal: "sys_messaging",
  });

  const core = new StoreCore(clock);
  const persisted = await listObjects<MessagingStoreOpPayload>(
    handle, "messagingStoreOp", undefined, { limit: 1_000_000 },
  );
  if (!persisted.ok) {
    throw new StoreException({
      name: "StoreUnavailable",
      message: `messagingStoreOp replay failed: ${persisted.error.code}`,
      retryable: true,
    });
  }

  const records = [...persisted.value.items]
    .map((item: StoredObject<MessagingStoreOpPayload>) => item.object)
    .sort((left, right) => left.storeSequence - right.storeSequence);

  let storeSequence = 0;
  const seenKeys = new Set<string>();
  for (const record of records) {
    core.applyOp(record.storeOp);
    seenKeys.add(record.operationKey);
    if (record.storeSequence > storeSequence) storeSequence = record.storeSequence;
  }

  core.attachPersistence(async (op: StoreOp) => {
    const operationKey = operationKeyOf(op);
    const payloadDigest = digestOf(op);
    // The one place the two identity vocabularies meet. Messaging's core is
    // deliberately free of `@novakai/foundation` types (requirement 1), so its
    // MessagingStoreOpId is its own brand over the same string Foundation
    // mints. This adapter IS the boundary; the cast belongs here and nowhere
    // else, and the b3c-identity suite proves both sides agree on the format.
    const id = mintMessagingStoreOpId(operationKey) as string as MessagingStoreOpId;

    // §8.1: "A retry reads the existing record and requires the same
    // payloadDigest." A same-key/same-digest retry is the SAME operation
    // arriving twice and must not append; a same-key/different-digest retry is
    // two different operations claiming one identity, which is corruption and
    // is refused rather than silently overwritten.
    if (seenKeys.has(operationKey)) {
      const existing = await getExisting(handle, id);
      if (existing !== null && existing.payloadDigest !== payloadDigest) {
        throw new StoreException({
          name: "StoreCorrupt",
          message:
            `messagingStoreOp ${operationKey} already exists with a different payload`,
        });
      }
      return;
    }

    storeSequence += 1;
    const payload: MessagingStoreOpPayload = {
      kind: "messagingStoreOp",
      id,
      schemaVersion: 1,
      createdAt: clock.now(),
      permissionLevel: "private",
      // Foundation derives the real `createdBy` from the scoped principal;
      // this value is overwritten and never trusted (red gate 5).
      createdBy: "overridden-by-foundation",
      storeSequence,
      operationKey,
      payloadDigest,
      storeOp: op,
    };
    const written = await createObject(
      handle, payload as unknown as Record<string, unknown> & {
        kind: string; id: string; schemaVersion: number; createdAt: string;
        permissionLevel: "private"; createdBy: string;
      },
      // The op's own identity IS the idempotency key, so Foundation's receipt
      // layer sees a retry as a retry. A freshly minted UUID per attempt would
      // make every retry a brand-new command — the defect B3b's audit found on
      // the wire path, one layer down.
      deriveClientOpId(`messagingStoreOp:${operationKey}`),
    );
    if (!written.ok) {
      storeSequence -= 1;
      throw new StoreException({
        name: "StoreUnavailable",
        message: `messagingStoreOp append failed: ${written.error.code} ${written.error.message}`,
        retryable: true,
      });
    }
    seenKeys.add(operationKey);
  }, async () => {
    // Foundation owns its own file handles; there is nothing of ours to close.
  });

  return core;
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
