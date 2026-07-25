/**
 * Orchestrator internals (F12/L1) — unit level against the real modules.
 *
 * F12: the retry-budget exhaustion attempt is recorded append-only EVEN when
 *      the exhaustion CAS loses to a concurrent settle (pre-fix the CAS
 *      result was ignored — on StateConflict no attempt was recorded, unlike
 *      settleFailed's discipline).
 * L1:  a non-StateConflict store failure inside settleDelivered is thrown,
 *      so the acceptance path leaves effectsPending true and the DEC-21
 *      sweep re-drives (pre-fix it was swallowed: the Delivery stayed
 *      pending with effects marked settled — invisible to the sweep).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { schemaVersion } from "../../public/contract/index.js";
import type {
  ClientMessageId,
  Delivery,
  Message,
  PersonId,
  RecipientSnapshot,
  RequestHash,
  Sequence,
  ThreadId,
} from "../../public/contract/index.js";
import { createMemoryStore } from "../../adapters/store-memory.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import type { SeededClock } from "../../adapters/clock-seeded.js";
import { createMemoryPresenceTransport } from "../../adapters/presence-transport-memory.js";
import type { StoreCore } from "../../adapters/store-shared.js";
import type { MessagingStore } from "../../seams/store.js";
import { createPresenceRegistry } from "../../core/presenceRegistry.js";
import { createDeliveryOrchestrator } from "../../core/deliveryOrchestrator.js";
import { runRecoverySweep } from "../../core/recoverySweep.js";
import { ManualScheduler } from "./helpers.js";

const ALICE = "person_alice" as PersonId;
const BOB = "person_bob" as PersonId;

interface AcceptedFixture {
  message: Message;
  delivery: Delivery;
}

async function commitFixture(store: MessagingStore, clock: SeededClock): Promise<AcceptedFixture> {
  const messageId = clock.newId("message");
  const message: Message = {
    id: messageId,
    kind: "message",
    schemaVersion,
    createdAt: clock.now(),
    threadId: "thread_placeholder" as ThreadId,
    senderId: ALICE,
    clientMessageId: "cm-fixture" as ClientMessageId,
    sequence: 0 as Sequence,
    priority: "normal",
    body: { text: "fixture" },
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
      clientMessageId: message.clientMessageId,
      requestHash: "a".repeat(64) as RequestHash,
    },
    thread: { kind: "direct", pair: [ALICE, BOB] },
    message,
    snapshot,
    deliveries: [delivery],
  });
  assert.equal(outcome.kind, "accepted");
  return { message: { ...message, threadId: (outcome.kind === "accepted" ? outcome.threadId : message.threadId) }, delivery };
}

describe("F12 — exhaustion attempt is recorded even when the CAS loses", () => {
  it("StateConflict on the exhaustion CAS still appends the exhaustion attempt", async () => {
    const clock = createSeededClock({ seed: "f12b" });
    const store = createMemoryStore(clock);
    const registry = createPresenceRegistry(clock);
    const transport = createMemoryPresenceTransport({ kind: "ws" });
    transport.setDeliverScript(() => ({ kind: "failure", retryable: true, detail: "busy" }));
    const orchestrator = createDeliveryOrchestrator({
      store,
      clock,
      registry,
      transports: new Map([["ws", transport]]),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1_000 },
      scheduler: new ManualScheduler(),
    });

    const { message, delivery } = await commitFixture(store, clock);
    await registry.open(BOB, "ws");

    // Start the effect leg, then win the CAS race externally: the external
    // delivered transition enqueues BEFORE the orchestrator's exhaustion CAS
    // (the store serialises mutations, F1), so the exhaustion CAS conflicts.
    const effectLeg = orchestrator.onAcceptance(message, [delivery], false);
    const won = await store.transitionDelivery(delivery.id, "pending", "delivered", "adapter-effect");
    assert.equal(won.kind, "ok");
    await effectLeg;

    const attempts = [...(store as unknown as StoreCore).state.attempts.values()];
    assert.ok(
      attempts.some((attempt) => attempt.detail === "retry budget exhausted"),
      "F12: the exhaustion attempt is recorded append-only even when the exhaustion CAS loses",
    );
    assert.ok(
      attempts.some((attempt) => attempt.detail === "busy"),
      "the failed lane attempt is recorded too",
    );
    await store.close();
  });
});

describe("L1 — a store failure inside settleDelivered is never swallowed", () => {
  it("StoreUnavailable on the delivered CAS leaves effectsPending true; the sweep re-drives to delivered", async () => {
    const clock = createSeededClock({ seed: "l1" });
    const inner = createMemoryStore(clock);
    let failOnce = true;
    const rigged = Object.create(inner) as MessagingStore;
    rigged.transitionDelivery = (deliveryId, expectedState, nextState, stateReason, attempt) => {
      if (failOnce) {
        failOnce = false;
        return Promise.resolve({
          kind: "error",
          error: { name: "StoreUnavailable", message: "injected (L1 test)", retryable: true },
        });
      }
      return inner.transitionDelivery(deliveryId, expectedState, nextState, stateReason, attempt);
    };

    const registry = createPresenceRegistry(clock);
    const transport = createMemoryPresenceTransport({ kind: "ws" }); // healthy: real effect
    const orchestrator = createDeliveryOrchestrator({
      store: rigged,
      clock,
      registry,
      transports: new Map([["ws", transport]]),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      scheduler: new ManualScheduler(),
    });

    const { message, delivery } = await commitFixture(rigged, clock);
    await registry.open(BOB, "ws");

    // L1: the settle failure propagates out of the acceptance effect leg.
    await assert.rejects(
      orchestrator.onAcceptance(message, [delivery], false),
      /StoreUnavailable|store unavailable/,
      "the store failure surfaces — the caller must leave effectsPending true",
    );

    const pending = await rigged.listPendingAcceptances();
    assert.equal(pending.kind, "ok");
    if (pending.kind === "ok") {
      assert.equal(
        pending.value.acceptances.length,
        1,
        "effects stay pending — the DEC-21 sweep can see the torn acceptance",
      );
    }

    // The sweep re-drives: the second settle succeeds (failOnce consumed).
    const report = await runRecoverySweep({ store: rigged, orchestrator });
    assert.deepEqual(report.failures, []);
    assert.equal(report.settled, 1);
    const deliveries = await rigged.getDeliveries(message.id);
    assert.equal(deliveries.kind, "ok");
    if (deliveries.kind === "ok") {
      assert.equal(deliveries.value[0]?.state, "delivered", "re-driven to the honest terminal state");
    }
    await rigged.close();
  });
});
