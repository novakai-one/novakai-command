/**
 * MSG-016 failure truth (S4): "Delivery failures are observable as
 * events/queryable state without creating an agent turn."
 *
 * Each leg drives a terminal failure to its honest end and asserts BOTH
 * observability surfaces agree, with no ack turn anywhere in the flow:
 *   1. the DeliveryUpdated failure stream — a subscriber observes the
 *      terminal failure transition as a journaled, pushed committed-fact
 *      event (state + machine-readable reason);
 *   2. GetDelivery — per-recipient status truth for the same failure.
 *
 * Existing coverage CITED (not duplicated here):
 *   - state mechanics: tests/core/delivery-retry.test.ts ("retryable failures
 *     exhaust the budget → failed{retry-exhausted}", "permanent failure →
 *     failed{transport-failure} immediately, no retries");
 *   - blocked-at-acceptance (R4/§11.7): tests/core/rooms.test.ts ("blocked
 *     recipient → terminal failed Delivery for that recipient only…",
 *     "path A/B" window tests);
 *   - event filter plumbing: tests/core/subscriptions.test.ts ("kind filter:
 *     a DeliveryUpdated-only subscription sees no MessageCommitted");
 *   - W3 walkthrough (Plan §16): commit → adapter failure → emitted +
 *     queryable, retry per adapter policy, no agent turn — legs 1–2 below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { SubscriptionMessage, SubscriptionSink } from "../../public/index.js";
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

function collectSink(): { sink: SubscriptionSink; frames: SubscriptionMessage[] } {
  const frames: SubscriptionMessage[] = [];
  return {
    frames,
    sink: async (frame) => {
      frames.push(frame);
      return { kind: "effect" };
    },
  };
}

interface DeliveryEventPayload {
  delivery: { recipientId: string; state: string; stateReason?: string };
}

function failureEvents(frames: SubscriptionMessage[]): DeliveryEventPayload[] {
  return frames
    .filter((frame) => frame.kind === "event")
    .map((frame) => (frame.kind === "event" ? (frame.event as unknown as DeliveryEventPayload) : undefined))
    .filter((event): event is DeliveryEventPayload => event?.delivery?.state === "failed");
}

describe("MSG-016 — failure truth: terminal failures are pushed events AND queryable state, no agent turn", () => {
  it("retry-exhausted: the subscriber observes DeliveryUpdated(failed, retry-exhausted); GetDelivery agrees", async () => {
    const { cap, transport, scheduler } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);
    await bob.openPresence({ transport: "ws" });

    // Every attempt fails retryably → the bounded budget (3 in the harness)
    // exhausts → terminal failed{retry-exhausted}.
    transport.setDeliverScript(() => ({ kind: "failure", retryable: true, detail: "lane flaky" }));

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["DeliveryUpdated"] }, sink));

    const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "will fail", "ft-1")));
    await scheduler.runAll(); // drive the parked retries to exhaustion
    await flushMicrotasks();
    await cap.pumpEvents(); // the journal tail publishes the committed facts

    // Surface 1: the failure stream.
    const failures = failureEvents(frames);
    assert.ok(
      failures.some(
        (event) =>
          event.delivery.recipientId === BOB && event.delivery.stateReason === "retry-exhausted",
      ),
      "a terminal retry-exhausted transition was pushed as a journaled DeliveryUpdated",
    );

    // Surface 2: per-recipient query truth — identical state + reason.
    const deliveries = unwrap(await alice.getDelivery({ messageId: accepted.messageId }));
    const bobs = deliveries.deliveries.find((delivery) => delivery.recipientId === BOB);
    assert.equal(bobs?.state, "failed");
    assert.equal(bobs?.stateReason, "retry-exhausted");
    await cap.close();
  });

  it("transport-failure: a permanent adapter failure is pushed and queryable as failed{transport-failure}", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);
    await bob.openPresence({ transport: "ws" });

    transport.setDeliverScript(() => ({
      kind: "failure",
      retryable: false,
      detail: "protocol error — permanent",
    }));

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["DeliveryUpdated"] }, sink));

    const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "permanent", "ft-2")));
    await flushMicrotasks();
    await cap.pumpEvents();

    const failures = failureEvents(frames);
    assert.ok(
      failures.some(
        (event) =>
          event.delivery.recipientId === BOB && event.delivery.stateReason === "transport-failure",
      ),
      "the permanent failure was pushed as DeliveryUpdated(failed, transport-failure)",
    );

    const deliveries = unwrap(await alice.getDelivery({ messageId: accepted.messageId }));
    const bobs = deliveries.deliveries.find((delivery) => delivery.recipientId === BOB);
    assert.equal(bobs?.state, "failed");
    assert.equal(bobs?.stateReason, "transport-failure");
    await cap.close();
  });

  it("blocked-by-contact-policy (R4/§11.7): the room-blocked recipient's terminal failure is pushed from the COMMIT and queryable", async () => {
    const { cap } = makeHarness({
      membership: {
        rooms: [
          {
            threadKind: "team",
            authority: "team-capability",
            externalId: "ft-room",
            members: [ALICE, BOB],
          },
        ],
      },
    });
    await cap.start(); // provisions the room Thread (Store-Seam §11.4)
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    // Bob never allows Alice (default deny, no shared direct thread): on a
    // ROOM send Bob's Delivery commits TERMINAL failed inside commitAcceptance
    // (§11.7) — and the commit itself journals the DeliveryUpdated (MSG-016).
    const threads = unwrap(await alice.listThreadsForPerson({}));
    const room = threads.threads.find((thread) => thread.threadKind === "team");
    assert.ok(room, "the provisioned room Thread is listed");

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["DeliveryUpdated"] }, sink));

    // The send itself is ACCEPTED (R4: blocked never rejects a room send).
    const accepted = unwrap(
      await alice.sendMessage(sendInput(`thread:${room.id}`, "room news", "ft-3")),
    );
    await flushMicrotasks();
    await cap.pumpEvents();

    const failures = failureEvents(frames);
    assert.ok(
      failures.some(
        (event) =>
          event.delivery.recipientId === BOB &&
          event.delivery.stateReason === "blocked-by-contact-policy",
      ),
      "the blocked recipient's terminal failure was pushed as a journaled DeliveryUpdated",
    );

    // GetDelivery: per-recipient truth — Bob terminal failed from the commit;
    // the sender's own Delivery is untouched by Bob's block.
    const deliveries = unwrap(await alice.getDelivery({ messageId: accepted.messageId }));
    const bobs = deliveries.deliveries.find((delivery) => delivery.recipientId === BOB);
    assert.equal(bobs?.state, "failed");
    assert.equal(bobs?.stateReason, "blocked-by-contact-policy");
    const alices = deliveries.deliveries.find((delivery) => delivery.recipientId === ALICE);
    assert.notEqual(alices?.state, "failed");

    // No agent turn: Bob was never served the blocked Message (§11.2 inbox).
    const inbox = unwrap(await bob.getInbox({}));
    assert.equal(inbox.messages.length, 0);
    await cap.close();
  });

  it("failure truth survives disconnect: cursor replay re-delivers the journaled failure events (R1)", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);
    await bob.openPresence({ transport: "ws" });
    transport.setDeliverScript(() => ({
      kind: "failure",
      retryable: false,
      detail: "permanent",
    }));

    // Subscribe AFTER the failure committed, replaying from the journal's
    // start: replay delivers the committed-fact failure event — the stream is
    // the durable record, not the live connection (R1).
    const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "durable", "ft-4")));
    await flushMicrotasks();

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["DeliveryUpdated"], since: "s_0" as never }, sink));
    await cap.pumpEvents();
    await flushMicrotasks();

    const failures = failureEvents(frames);
    assert.ok(
      failures.some(
        (event) =>
          event.delivery.recipientId === BOB && event.delivery.stateReason === "transport-failure",
      ),
      "replay re-delivers the journaled failure — observability is durable, not connection-bound",
    );
    void accepted;
    await cap.close();
  });
});
