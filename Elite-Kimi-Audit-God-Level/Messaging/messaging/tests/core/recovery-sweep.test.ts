/**
 * DEC-21 recovery sweep: an acceptance left effectsPending (the crash window
 * between commit and settle) is re-driven to completion — effects settled,
 * delivery attempted — idempotently, and safely with zero pending.
 *
 * The crash window is simulated honestly: a wrapping store fails the FIRST
 * markEffectsSettled call (the send pipeline's post-commit leg swallows the
 * failure per DEC-09 — SendAccepted still returns, the marker stays true).
 * The sweep is the recovery path the standalone root runs at startup.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, createSeededClock } from "../../public/index.js";
import type { MessageId, MessagingStore } from "../../public/index.js";
import {
  ALICE,
  BOB,
  allowlist,
  flushMicrotasks,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

/** A store that fails markEffectsSettled once (the post-commit crash window), then behaves. */
function failFirstSettle(store: MessagingStore): MessagingStore {
  let failuresLeft = 1;
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "markEffectsSettled") {
        return async (
          messageId: MessageId,
        ): ReturnType<MessagingStore["markEffectsSettled"]> => {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            return {
              kind: "error",
              error: {
                name: "StoreUnavailable",
                message: "simulated post-commit crash window",
                retryable: true,
              },
            };
          }
          return target.markEffectsSettled(messageId);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A harness whose store fails the first effects-settle (the DEC-21 crash window). */
function crashingHarness() {
  const clock = createSeededClock({ seed: "core" });
  const store = failFirstSettle(createMemoryStore(clock));
  return makeHarness({ clock, store });
}

describe("Recovery sweep (DEC-21)", () => {
  it("zero pending: the sweep is a safe no-op", async () => {
    const { cap } = makeHarness();
    const report = await cap.runRecoverySweep();
    assert.deepEqual(report, { found: 0, settled: 0, failures: [] });
    await cap.close();
  });

  it("an effects-pending acceptance is re-driven: effects settle, delivery is attempted", async () => {
    // Bob has NO presence at send time — the delivery stays pending (R5
    // no-presence rule); the sweep's job is driving EFFECTS, not forcing delivery.
    const { cap, transport } = crashingHarness();

    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);

    // The send is ACCEPTED (DEC-09 durability) even though the settle leg fails.
    const sent = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "swept", "m-sw1")));
    const pendingBefore = await cap.store.listPendingAcceptances();
    assert.equal(pendingBefore.kind, "ok");
    if (pendingBefore.kind === "ok") {
      assert.equal(pendingBefore.value.acceptances.length, 1, "the crash window left the marker true");
    }

    const report = await cap.runRecoverySweep();
    assert.equal(report.found, 1);
    assert.equal(report.settled, 1, "the sweep re-drove and settled the acceptance");
    assert.deepEqual(report.failures, []);

    const pendingAfter = await cap.store.listPendingAcceptances();
    assert.equal(pendingAfter.kind, "ok");
    if (pendingAfter.kind === "ok") {
      assert.equal(pendingAfter.value.acceptances.length, 0, "marker cleared (idempotent settle)");
    }

    // Eventual-effect (DEC-09 second half): when bob opens a presence, the
    // re-trigger delivers — the acceptance was never lost.
    unwrap(await bob.openPresence({ transport: "ws" }));
    await flushMicrotasks();
    assert.ok(
      transport.effects.some((effect) => effect.payload.message.id === sent.messageId),
      "the swept acceptance still delivers honestly (DEC-08 real effect)",
    );

    // Idempotent: a second sweep finds nothing.
    const second = await cap.runRecoverySweep();
    assert.deepEqual(second, { found: 0, settled: 0, failures: [] });
    await cap.close();
  });

  it("re-driving an already-delivered acceptance is a no-op (CAS idempotency)", async () => {
    const { cap, transport } = crashingHarness();

    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws" }));

    const sent = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "already there", "m-sw2")));
    // Delivered inline (bob had a presence); only the SETTLE failed.
    assert.equal(transport.effects.length, 1);

    const report = await cap.runRecoverySweep();
    assert.equal(report.found, 1);
    assert.equal(report.settled, 1);
    assert.equal(
      transport.effects.length,
      1,
      "the re-drive did NOT re-attempt a delivered Delivery — the CAS machine is idempotent",
    );

    const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    assert.equal(deliveries.deliveries[0]?.state, "delivered");
    await cap.close();
  });

  it("F11: the periodic sweep (sweepIntervalMs) settles a torn acceptance with no manual drive", async () => {
    // Store-Seam §7: the sweep runs on startup AND periodically. A real
    // (unref'd) interval drives it here — 30 ms, real timers.
    const clock = createSeededClock({ seed: "f11" });
    const store = failFirstSettle(createMemoryStore(clock));
    const { cap } = makeHarness({ clock, store, sweepIntervalMs: 30 });

    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);

    // Accepted (DEC-09); the settle leg fails → effectsPending stays true.
    unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "swept periodically", "m-f11")));
    const before = await cap.store.listPendingAcceptances();
    assert.equal(before.kind, "ok");
    if (before.kind === "ok") {
      assert.equal(before.value.acceptances.length, 1, "the crash window left the marker true");
    }

    // NO manual runRecoverySweep call: the interval must drive it (F11).
    const deadline = Date.now() + 5_000;
    for (;;) {
      const pending = await cap.store.listPendingAcceptances();
      assert.equal(pending.kind, "ok");
      if (pending.kind === "ok" && pending.value.acceptances.length === 0) break;
      assert.ok(Date.now() < deadline, "F11: the periodic sweep never ran");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await cap.close();
  });
});
