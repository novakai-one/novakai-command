/**
 * eventBus failure/concurrency discipline (L2/L3) — unit level, against the
 * real bus over store-memory. The door-level proof that concurrent tails
 * never duplicate frames within a subscription lives in
 * tests/core/subscriptions.test.ts ("F6: concurrent journal tails …").
 *
 * L3: pre-fix a throwing listener stalled the bus silently — the checkpoint
 * was not advanced, no error was surfaced, and the same fact was retried
 * every tail cycle forever. Post-fix: the throw is surfaced via onError,
 * other listeners still see the fact, the checkpoint advances, and the next
 * cycle does NOT re-emit.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { schemaVersion } from "../../contract/index.js";
import type {
  ClientMessageId,
  Delivery,
  Message,
  PersonId,
  RecipientSnapshot,
  RequestHash,
  Sequence,
  ThreadId,
} from "../../contract/index.js";
import { createEventBus } from "../../core/eventBus.js";
import type { CommittedFact } from "../../core/eventBus.js";
import { createMemoryStore } from "../../adapters/store-memory.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";

const ALICE = "person_alice" as PersonId;
const BOB = "person_bob" as PersonId;

async function commitOne(store: ReturnType<typeof createMemoryStore>, clock: ReturnType<typeof createSeededClock>) {
  const messageId = clock.newId("message");
  const message: Message = {
    id: messageId,
    kind: "message",
    schemaVersion,
    createdAt: clock.now(),
    threadId: "thread_placeholder" as ThreadId,
    senderId: ALICE,
    clientMessageId: "l3-1" as ClientMessageId,
    sequence: 0 as Sequence,
    priority: "normal",
    body: { text: "l3" },
  };
  const snapshot: RecipientSnapshot = {
    id: clock.newId("snapshot"),
    kind: "recipient-snapshot",
    schemaVersion,
    createdAt: clock.now(),
    messageId,
    recipients: [BOB],
  };
  const delivery: Delivery = {
    id: clock.newId("delivery"),
    kind: "delivery",
    schemaVersion,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    messageId,
    threadId: "thread_placeholder" as ThreadId,
    recipientId: BOB,
    state: "pending",
  };
  const outcome = await store.commitAcceptance({
    idempotency: {
      senderId: ALICE,
      clientMessageId: "l3-1" as ClientMessageId,
      requestHash: "a".repeat(64) as RequestHash,
    },
    thread: { kind: "direct", pair: [ALICE, BOB] },
    message,
    snapshot,
    deliveries: [delivery],
  });
  assert.equal(outcome.kind, "accepted");
}

describe("eventBus — listener failure and tail discipline (L2/L3)", () => {
  it("L3: a throwing listener is surfaced via onError, never stalls the bus, and the fact is not retried", async () => {
    const clock = createSeededClock({ seed: "l3" });
    const store = createMemoryStore(clock);
    const bus = createEventBus(store);

    const seen: CommittedFact[] = [];
    const errors: string[] = [];
    bus.onFact(async () => {
      throw new Error("listener bug (test)");
    });
    bus.onFact(async (fact) => {
      seen.push(fact);
    });
    bus.onError((error) => {
      errors.push(error.name);
    });

    await commitOne(store, clock);
    await bus.start();
    await bus.pump();

    assert.equal(seen.length, 1, "the healthy listener still received the fact");
    assert.ok(errors.length >= 1, "the throw was surfaced via onError, not swallowed");
    const positionAfterFirst = bus.position;
    assert.ok(positionAfterFirst > 0, "the checkpoint advanced past the fact");

    await bus.pump();
    assert.equal(seen.length, 1, "L3: the same fact is NOT retried on the next cycle");
    assert.equal(bus.position, positionAfterFirst, "no regression, no re-emission");
    await store.close();
  });

  it("L2: a pump requested mid-cycle forces a rerun so no commit is stranded", async () => {
    const clock = createSeededClock({ seed: "l2" });
    const store = createMemoryStore(clock);
    const bus = createEventBus(store);

    const seen: CommittedFact[] = [];
    bus.onFact(async (fact) => {
      seen.push(fact);
    });

    await bus.start();
    // Two overlapping pumps plus a commit landing between them: the guard
    // must serialize the tails and the rerun flag must pick up anything the
    // in-flight cycle's scan could have missed.
    const first = bus.pump();
    const second = bus.pump();
    await commitOne(store, clock);
    const third = bus.pump();
    await Promise.all([first, second, third]);
    await bus.pump();

    assert.equal(seen.length, 1, "exactly one emission for exactly one committed fact");
    await store.close();
  });
});
