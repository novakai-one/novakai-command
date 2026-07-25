/**
 * The R5 failure lane and retry budget (adapter configuration; v1 semantics):
 * transient failure → bounded retry with backoff → retry-exhausted; permanent
 * failure → transport-failure immediately; a recovered transport settles on
 * the retry. Terminal failure is observable via GetDelivery (MSG-016) — no
 * agent turn is ever created to ack.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import type { EffectReport } from "../../public/index.js";
import {
  ALICE,
  BOB,
  TEST_RETRY_POLICY,
  allowlist,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

describe("delivery retry + exhaustion (R5)", () => {
  it("retryable failures exhaust the budget → failed{retry-exhausted}", async () => {
    const { cap, transport, scheduler } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws" }));
    transport.setDeliverScript((): EffectReport => ({
      kind: "failure",
      retryable: true,
      detail: "socket backpressure",
    }));

    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "flaky lane", "rty-1")),
    );
    assert.equal(transport.attempts.length, 1, "first attempt at the acceptance decision point");
    assert.equal(scheduler.pending, 1, "a retry is scheduled, not spun");

    await scheduler.runAll();

    const { deliveries } = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries[0]?.state, "failed");
    assert.equal(deliveries[0]?.stateReason, "retry-exhausted");
    assert.equal(
      transport.attempts.length,
      TEST_RETRY_POLICY.maxAttempts,
      "the bounded budget ran out (adapter config)",
    );
    // Terminal failure is observable truth (MSG-016), and the inbox is clean.
    assert.equal(unwrap(await bob.getInbox({})).messages.length, 0);
  });

  it("permanent failure → failed{transport-failure} immediately, no retries", async () => {
    const { cap, transport, scheduler } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws" }));
    transport.setDeliverScript((): EffectReport => ({
      kind: "failure",
      retryable: false,
      detail: "protocol error",
    }));

    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "dead lane", "rty-2")),
    );
    const { deliveries } = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries[0]?.state, "failed");
    assert.equal(deliveries[0]?.stateReason, "transport-failure");
    assert.equal(transport.attempts.length, 1);
    assert.equal(scheduler.pending, 0, "no retries on a permanent failure");
  });

  it("a transient failure that recovers settles delivered on the retry", async () => {
    const { cap, transport, scheduler } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws" }));
    let calls = 0;
    transport.setDeliverScript((): EffectReport => {
      calls += 1;
      return calls === 1
        ? { kind: "failure", retryable: true, detail: "busy" }
        : { kind: "effect" };
    });

    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "recovering lane", "rty-3")),
    );
    assert.equal(
      unwrap(await bob.getDelivery({ messageId: accepted.messageId })).deliveries[0]?.state,
      "pending",
      "still pending between attempts",
    );

    await scheduler.runAll();
    const { deliveries } = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries[0]?.state, "delivered");
    assert.equal(deliveries[0]?.stateReason, "adapter-effect");
    assert.equal(transport.attempts.length, 2);
  });

  it("F12: presence-gone flaps do not burn the retry budget — only real retryable attempts count", async () => {
    const { cap, transport, scheduler } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    // Every lane dies mid-effect: the decision round contacts the transport
    // but the presence is gone — pending stands (R5 no-presence rule).
    transport.setDeliverScript((): EffectReport => ({
      kind: "failure",
      retryable: false,
      detail: "socket died mid-effect (test)",
      permanent: "presence-gone",
    }));

    unwrap(await bob.openPresence({ transport: "ws" }));
    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "flapping lane", "f12-1")),
    );
    assert.equal(
      unwrap(await bob.getDelivery({ messageId: accepted.messageId })).deliveries[0]?.state,
      "pending",
      "presence-gone: pending, never failed",
    );

    // Flap: two more open → decision rounds, each presence-gone again.
    // Pre-fix each round incremented the budget counter without a real retry.
    unwrap(await bob.openPresence({ transport: "ws" }));
    unwrap(await bob.openPresence({ transport: "ws" }));

    // Now a REAL retryable failure: with an honest budget this is attempt 1
    // of 3 — a retry is scheduled. Pre-fix the counter was already 3, so
    // this round exhausted the budget with ZERO retries ever scheduled.
    transport.setDeliverScript((): EffectReport => ({
      kind: "failure",
      retryable: true,
      detail: "busy",
    }));
    unwrap(await bob.openPresence({ transport: "ws" }));

    const { deliveries } = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(
      deliveries[0]?.state,
      "pending",
      "F12: the flaps did not burn the budget — the first real retryable failure must not exhaust it",
    );
    assert.equal(scheduler.pending, 1, "a retry is scheduled, not exhausted");
    await cap.close();
  });

  it("DEC-16 fan-out: all live Presences attempted, first real effect settles", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws", clientLabel: "machine-1" }));
    unwrap(await bob.openPresence({ transport: "ws", clientLabel: "machine-2" }));

    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "two machines", "rty-4")),
    );
    const { deliveries } = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries[0]?.state, "delivered");
    assert.equal(transport.attempts.length, 2, "both presences attempted (DEC-16)");
    assert.ok(
      transport.effects.length >= 1,
      "at least one real effect; the CAS settled exactly once (I11)",
    );
  });
});
