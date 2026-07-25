/**
 * Subscribe stream op (R1) through the embedded door: happy path, kind
 * filtering, R3 payload filtering, PolicyChanged audience, PresenceChanged
 * observations (R11), cursor replay after disconnect (exactly-once within a
 * subscription, at-least-once across), bounded-buffer overflow, explicit
 * scope authorization, auth-lost teardown, and door validation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  constants,
  cursorFor,
} from "../../public/index.js";
import type {
  Sequence,
  SubscriptionEndedFrame,
  SubscriptionMessage,
  SubscriptionSink,
} from "../../public/index.js";
import {
  ALICE,
  BOB,
  CHIEF,
  allowlist,
  expectError,
  flushMicrotasks,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

/** A collecting sink: every frame recorded; reports a real effect (healthy lane). */
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

function eventFrames(frames: SubscriptionMessage[]) {
  return frames.filter((frame) => frame.kind === "event");
}

function endedFrames(frames: SubscriptionMessage[]): SubscriptionEndedFrame[] {
  return frames.filter((frame): frame is SubscriptionEndedFrame => frame.kind === "ended");
}

describe("Subscribe — happy path and filters (R1/R2/R3)", () => {
  it("started first, then MessageCommitted pushed after the journal tail — never polled", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    const { sink, frames } = collectSink();
    const handle = unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));
    assert.ok(handle.subscriptionId.startsWith("subscription_"));

    const sent = unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "hello", "m-1")));
    await cap.pumpEvents();
    await flushMicrotasks();

    assert.equal(frames[0]?.kind, "started", "started is always the first frame");
    const events = eventFrames(frames);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.sequence, sent.sequence);
    const payload = events[0]?.event as { message: { body: { text: string }; senderId: string } };
    assert.equal(payload.message.body.text, "hello");
    assert.equal(payload.message.senderId, BOB);
    await cap.close();
  });

  it("kind filter: a DeliveryUpdated-only subscription sees no MessageCommitted", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["DeliveryUpdated"] }, sink));

    unwrap(await alice.openPresence({ transport: "ws" }));
    unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "deliver me", "m-2")));
    await cap.pumpEvents();
    await flushMicrotasks();

    const events = eventFrames(frames);
    assert.ok(events.length >= 1, "the delivered transition is a journaled committed fact (§11.1)");
    for (const frame of events) {
      const payload = frame.event as { delivery: { state: string } };
      assert.ok(payload.delivery !== undefined, "only DeliveryUpdated payloads arrive");
    }
    const states = events.map((frame) => (frame.event as { delivery: { state: string } }).delivery.state);
    assert.ok(states.includes("delivered"), "the delivered transition is observable (DEC-08 effect)");
    await cap.close();
  });

  it("R3: a non-member subscriber never receives a thread's MessageCommitted", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const chief = await sessionFor(cap, "tok-chief");
    await allowlist(alice, BOB);

    const { sink, frames } = collectSink();
    unwrap(await chief.subscribe({ events: ["MessageCommitted"] }, sink));

    unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "private", "m-3")));
    await cap.pumpEvents();
    await flushMicrotasks();

    assert.equal(eventFrames(frames).length, 0, "chief is not in the alice↔bob pair — no push, no leak");
    await cap.close();
  });

  it("R3: PolicyChanged reaches the owner and policy.admin, never other principals", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const admin = await sessionFor(cap, "tok-admin");

    const aliceSink = collectSink();
    const bobSink = collectSink();
    const adminSink = collectSink();
    unwrap(await alice.subscribe({ events: ["PolicyChanged"] }, aliceSink.sink));
    unwrap(await bob.subscribe({ events: ["PolicyChanged"] }, bobSink.sink));
    unwrap(await admin.subscribe({ events: ["PolicyChanged"] }, adminSink.sink));

    unwrap(await alice.setDndPolicy({ enabled: true }));
    await cap.pumpEvents();
    await flushMicrotasks();

    assert.equal(eventFrames(aliceSink.frames).length, 1, "the policy owner is notified");
    assert.equal(eventFrames(adminSink.frames).length, 1, "policy.admin holders are notified");
    assert.equal(eventFrames(bobSink.frames).length, 0, "no one else sees alice's policy (R3)");
    const payload = eventFrames(aliceSink.frames)[0]?.event as { personId: string; policy: string };
    assert.equal(payload.personId, ALICE);
    assert.equal(payload.policy, "dnd");
    await cap.close();
  });

  it("R11: PresenceChanged observations carry no sequence; current state arrives fresh on subscribe", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    // Bob's presence exists BEFORE alice subscribes → fresh observation on attach (R1).
    const opened = unwrap(await bob.openPresence({ transport: "ws" }));

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["PresenceChanged"] }, sink));
    await flushMicrotasks();

    const initial = eventFrames(frames);
    assert.equal(initial.length, 1, "current presence state is sent as a fresh observation");
    assert.equal(initial[0]?.sequence, undefined, "observations carry no sequence (R11)");
    const firstPayload = initial[0]?.event as { presence: { id: string }; change: string };
    assert.equal(firstPayload.presence.id, opened.presenceId);
    assert.equal(firstPayload.change, "opened");

    // Live open and close arrive as observations, still sequence-less.
    unwrap(await bob.closePresence({ presenceId: opened.presenceId }));
    await flushMicrotasks();
    const closedFrame = eventFrames(frames).find(
      (frame) => (frame.event as { change: string }).change === "closed",
    );
    assert.ok(closedFrame !== undefined, "the close observation arrives live");
    assert.equal(closedFrame.sequence, undefined);
    await cap.close();
  });

  it("L6: a presence change during the replay→live window is held and delivered after the snapshot", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    // A long replay window: enough journaled facts that the replay spans
    // many store reads, so the presence open below lands mid-replay.
    for (let i = 0; i < 60; i += 1) {
      unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, `l6 ${i}`, `l6-${i}`)));
    }
    const first = unwrap(await bob.openPresence({ transport: "ws", clientLabel: "before" }));

    const { sink, frames } = collectSink();
    const attaching = alice.subscribe({ events: ["MessageCommitted", "PresenceChanged"] }, sink);
    // Lands while the attach is replaying (the replay outlasts this open).
    const second = unwrap(await bob.openPresence({ transport: "ws", clientLabel: "during" }));
    unwrap(await attaching);
    await flushMicrotasks();

    const observations = eventFrames(frames).filter(
      (frame) => (frame.event as { presence?: { id: string } }).presence !== undefined,
    );
    const seenIds = observations.map(
      (frame) => (frame.event as { presence: { id: string } }).presence.id,
    );
    assert.ok(seenIds.includes(first.presenceId), "snapshot observation for the pre-existing presence");
    assert.ok(
      seenIds.includes(second.presenceId),
      "L6: the mid-replay open is held, not dropped — observations self-heal through the window",
    );
    await cap.close();
  });

  it("PresenceChanged is NOT DND-gated (R2): an open subscription is an explicit attention grant", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    // Alice enables DND — the observation lane must keep flowing (R2).
    unwrap(await alice.setDndPolicy({ enabled: true }));

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["PresenceChanged"] }, sink));
    unwrap(await bob.openPresence({ transport: "ws" }));
    await flushMicrotasks();

    assert.ok(
      eventFrames(frames).some((frame) => (frame.event as { change: string }).change === "opened"),
      "DND never gates the observation lane",
    );
    await cap.close();
  });
});

describe("Subscribe — cursor replay after disconnect (R1, W4 replay leg)", () => {
  it("re-subscribe with since replays missed committed facts exactly once, in order, then live", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    // First subscription: receives m1 live.
    const first = collectSink();
    const firstHandle = unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, first.sink));
    const m1 = unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "one", "m-r1")));
    await cap.pumpEvents();
    await flushMicrotasks();
    assert.equal(eventFrames(first.frames).length, 1);

    // Disconnect (transport close ends the subscription — same end state here).
    await firstHandle.close();

    // While away: m2 and m3 are committed (and journaled, §11.1).
    const m2 = unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "two", "m-r2")));
    const m3 = unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "three", "m-r3")));

    // Reconnect with the last-seen cursor → replay, then live.
    const second = collectSink();
    unwrap(
      await alice.subscribe(
        { events: ["MessageCommitted"], since: cursorFor(m1.sequence) },
        second.sink,
      ),
    );
    await flushMicrotasks();

    const replayed = eventFrames(second.frames);
    assert.deepEqual(
      replayed.map((frame) => frame.sequence),
      [m2.sequence, m3.sequence],
      "exactly the missed events replay, in journal order — no duplicates, no gap",
    );
    assert.equal(
      (second.frames[0] as { replayedFrom?: string }).replayedFrom,
      cursorFor(m1.sequence),
      "started carries replayedFrom",
    );

    // Live tail continues after the replay.
    const m4 = unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "four", "m-r4")));
    await cap.pumpEvents();
    await flushMicrotasks();
    assert.deepEqual(
      eventFrames(second.frames).map((frame) => frame.sequence),
      [m2.sequence, m3.sequence, m4.sequence],
      "replay closes the gap without polling; live follows in order",
    );

    // At-least-once honesty: re-subscribing with an OLD cursor replays m2/m3
    // again — the consumer dedupes by sequence; exactly-once is never promised.
    const third = collectSink();
    unwrap(
      await alice.subscribe(
        { events: ["MessageCommitted"], since: cursorFor(m1.sequence) },
        third.sink,
      ),
    );
    await flushMicrotasks();
    assert.deepEqual(
      eventFrames(third.frames).map((frame) => frame.sequence),
      [m2.sequence, m3.sequence, m4.sequence],
      "replay from an old cursor is a superset — dedupe is the consumer's job (R1)",
    );
    await cap.close();
  });

  it("F6: concurrent journal tails never duplicate or reorder frames within a subscription", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));

    const sent = [];
    for (let i = 0; i < 3; i += 1) {
      sent.push(unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, `f6 ${i}`, `f6-${i}`))));
    }
    // F6/L2: three overlapping tail cycles. Pre-fix the interval/pump tails
    // were unguarded and per-subscription offers unchained — the same facts
    // were emitted twice and the watermark could regress.
    await Promise.all([cap.pumpEvents(), cap.pumpEvents(), cap.pumpEvents()]);
    await flushMicrotasks();

    assert.deepEqual(
      eventFrames(frames).map((frame) => frame.sequence),
      sent.map((message) => message.sequence),
      "in-order, no gap, no overlap within the subscription — even under concurrent tails",
    );
    await cap.close();
  });

  it("replay is R3-filtered too: a non-member replays nothing", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const chief = await sessionFor(cap, "tok-chief");
    await allowlist(alice, BOB);
    unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "secret", "m-rf")));

    const { sink, frames } = collectSink();
    unwrap(await chief.subscribe({ events: ["MessageCommitted"] }, sink));
    await flushMicrotasks();
    assert.equal(eventFrames(frames).length, 0, "replay honors the same R3 filter as live");
    await cap.close();
  });
});

describe("Subscribe — bounded buffer and overflow (R1 backpressure)", () => {
  it("F7: overflow during REPLAY still delivers started first — ended is never the first frame", async () => {
    const bufferMax = 3;
    const { cap } = makeHarness({ subscriptionBufferMax: bufferMax });
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    // Journal more committed facts than the buffer holds BEFORE the
    // subscription attaches, so the replay itself overflows the buffer.
    for (let i = 0; i < 6; i += 1) {
      unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, `backlog ${i}`, `f7-${i}`)));
    }

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));
    await flushMicrotasks();

    assert.equal(frames[0]?.kind, "started", "F7: started is ALWAYS the first frame (R1 lifecycle)");
    const ended = endedFrames(frames);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.reason, "overflow", "the replay overflow still ends the subscription");
    await cap.close();
  });

  it("a buffer that fills ENDS the subscription with ended{overflow} — the core never blocks", async () => {
    const bufferMax = 3;
    const { cap } = makeHarness({ subscriptionBufferMax: bufferMax });
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    // A stalled lane: event frames transient-fail (parked); the ended frame is
    // allowed through so the test can observe the overflow verdict.
    const seen: SubscriptionMessage[] = [];
    const sink: SubscriptionSink = async (frame) => {
      seen.push(frame);
      if (frame.kind === "ended") return { kind: "effect" };
      return { kind: "failure", retryable: true, detail: "stalled lane (test)" };
    };
    unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));

    for (let i = 0; i < 6; i += 1) {
      unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, `flood ${i}`, `m-o${i}`)));
    }
    await cap.pumpEvents();
    await flushMicrotasks();

    const ended = endedFrames(seen);
    assert.equal(ended.length, 1, "the subscription ended exactly once");
    assert.equal(ended[0]?.reason, "overflow", "R1 overflow behaviour — re-subscribe with last cursor");
    // The bound held: on a stalled lane the only frames the core ever
    // attempted are the parked head (started, retried on the cadence — each
    // attempt is the SAME frame, never new queueing) and the terminal
    // started→ended pair (F7). No event frame crossed; nothing queued
    // unboundedly (the buffer dropped at overflow is the proof).
    assert.ok(
      seen.every((frame) => frame.kind === "started" || frame.kind === "ended"),
      "only the parked head and the terminal frames were attempted — never an unbounded backlog",
    );
    // F7: started must be ATTEMPTED before ended, always.
    const firstEndedIndex = seen.findIndex((frame) => frame.kind === "ended");
    assert.ok(
      seen.slice(0, firstEndedIndex).some((frame) => frame.kind === "started"),
      "started was attempted before ended (F7)",
    );
    await cap.close();
  });

  it("a transient push failure parks the head frame and retries — no event is skipped", async () => {
    const { cap, scheduler } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    const seen: SubscriptionMessage[] = [];
    let failing = true;
    const sink: SubscriptionSink = async (frame) => {
      if (failing && frame.kind === "event") {
        return { kind: "failure", retryable: true, detail: "transient (test)" };
      }
      seen.push(frame);
      return { kind: "effect" };
    };
    unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));
    const m1 = unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "parked", "m-t1")));
    await cap.pumpEvents();
    await flushMicrotasks();
    assert.equal(eventFrames(seen).length, 0, "the frame is parked, not dropped");

    failing = false;
    await scheduler.runAll(); // the parked-frame retry cadence fires
    await flushMicrotasks();
    assert.deepEqual(
      eventFrames(seen).map((frame) => frame.sequence),
      [m1.sequence],
      "the parked frame is retried and lands exactly once",
    );
    await cap.close();
  });
});

describe("Subscribe — scope, teardown, and door validation", () => {
  it("explicit scope confines events to the named thread", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(alice, BOB);

    // The alice↔alice self lane is a second thread alice may read.
    const selfSend = unwrap(await alice.sendMessage(sendInput(`person:${ALICE}`, "me", "m-s0")));

    const { sink, frames } = collectSink();
    unwrap(
      await alice.subscribe({ events: ["MessageCommitted"], threads: [selfSend.threadId] }, sink),
    );
    // Attach replays the in-scope self-message (since absent → replay from 0).
    assert.equal(eventFrames(frames).length, 1, "in-scope history replays at attach");

    unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "other thread", "m-s1")));
    await cap.pumpEvents();
    await flushMicrotasks();
    assert.equal(eventFrames(frames).length, 1, "out-of-scope threads are filtered");

    unwrap(await alice.sendMessage(sendInput(`person:${ALICE}`, "in scope", "m-s2")));
    await cap.pumpEvents();
    await flushMicrotasks();
    assert.equal(eventFrames(frames).length, 2, "in-scope events flow");
    await cap.close();
  });

  it("explicit scope naming an unreadable thread fails the whole Subscribe (NotAuthorized, G6)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const chief = await sessionFor(cap, "tok-chief");
    await allowlist(chief, BOB);
    const foreign = unwrap(await bob.sendMessage(sendInput(`person:${CHIEF}`, "theirs", "m-x0")));

    const { sink } = collectSink();
    const error = expectError(
      await alice.subscribe({ events: ["MessageCommitted"], threads: [foreign.threadId] }, sink),
    );
    assert.equal(error.name, "NotAuthorized", "scope is never silently dropped");

    const error2 = expectError(
      await alice.subscribe(
        { events: ["MessageCommitted"], threads: ["thread_nonexistent" as never] },
        sink,
      ),
    );
    assert.equal(error2.name, "NotAuthorized", "a nonexistent thread is unreadable by definition");
    await cap.close();
  });

  it("auth-lost: an invalidated session ends its subscriptions with ended{auth-lost} (§2.1)", async () => {
    const { cap, authority } = makeHarness();
    const auth = await cap.authenticate({ token: "tok-alice" });
    if (auth.kind !== "authenticated") throw new Error("auth failed");
    const alice = auth.session;

    const { sink, frames } = collectSink();
    unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));

    authority.invalidateSession(auth.principal.sessionId);
    assert.equal(await alice.revalidate(), "ended");
    await flushMicrotasks();

    const ended = endedFrames(frames);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.reason, "auth-lost", "§2.1: invalid revalidation terminates live subscriptions");

    // And the session guard now forbids operations.
    const blocked = await alice.getInbox({});
    assert.equal(blocked.kind, "error");
    await cap.close();
  });

  it("presence binding requires the session's own live Presence", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const bobPresence = unwrap(await bob.openPresence({ transport: "ws" }));

    const { sink } = collectSink();
    const error = expectError(
      await alice.subscribe({ events: ["MessageCommitted"] }, sink, {
        presenceId: bobPresence.presenceId,
      }),
    );
    assert.equal(error.name, "ValidationFailed", "no piggybacking on another principal's presence");
    await cap.close();
  });

  it("door validation: bad events / bad cursor / unknown keys → ValidationFailed, never a throw", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const { sink } = collectSink();

    for (const bad of [
      {},
      { events: [] },
      { events: ["Nonsense"] },
      { events: ["MessageCommitted", "MessageCommitted"] },
      { events: ["MessageCommitted"], since: "not-a-cursor" },
      { events: ["MessageCommitted"], bogus: true },
    ]) {
      const outcome = await alice.subscribe(bad, sink);
      assert.equal(outcome.kind, "error", `rejected: ${JSON.stringify(bad)}`);
      if (outcome.kind === "error") assert.equal(outcome.error.name, "ValidationFailed");
    }
    await cap.close();
  });

  it("constants.subscriptionBufferMax is the default bound (contract constant, not hand-copied)", () => {
    assert.equal(constants.subscriptionBufferMax, 256);
  });
});
