/**
 * W2 — accept, crash, retry: durability and idempotency
 * (Plan §16 W2; DEC-09/13/18/20, A5, MSG-018/019).
 *
 * Plus the plain happy path the W1 walkthrough starts from: an online 1-1
 * send delivers end-to-end through the real seam choreography.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  ALICE,
  BOB,
  allowlist,
  expectError,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

describe("W2 — durability and idempotent retry", () => {
  it("online 1-1 send delivers end-to-end (DEC-08 real effect)", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws", clientLabel: "bob-terminal" }));

    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "hello bob", "w2-0")),
    );
    assert.equal(accepted.urgentDowngraded, undefined);
    assert.equal(accepted.duplicate, undefined);

    const { deliveries } = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries[0]?.state, "delivered");
    assert.equal(deliveries[0]?.stateReason, "adapter-effect");
    assert.equal(transport.effects.length, 1);
    assert.equal(transport.effects[0]?.payload.message.id, accepted.messageId);

    // The message is in the shared direct thread's history (DEC-03).
    const thread = unwrap(await alice.getThread({ threadId: accepted.threadId }));
    assert.equal(thread.threadKind, "direct");
    const history = unwrap(await bob.getMessages({ threadId: accepted.threadId }));
    assert.deepEqual(history.messages.map((m) => m.id), [accepted.messageId]);
  });

  it("same command twice → duplicate outcome, exactly one Message, no double delivery (DEC-13, I1)", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws" }));

    const command = sendInput(`person:${BOB}`, "retry me", "w2-1");
    const first = unwrap(await alice.sendMessage(command));
    const retry = unwrap(await alice.sendMessage(command));

    assert.equal(retry.duplicate, true, "the retry surfaces the original acceptance");
    assert.equal(retry.messageId, first.messageId);
    assert.equal(retry.threadId, first.threadId);
    assert.equal(retry.sequence, first.sequence);

    const history = unwrap(await bob.getMessages({ threadId: first.threadId }));
    assert.equal(history.messages.length, 1, "exactly one Message exists (I1)");
    const { deliveries } = unwrap(await bob.getDelivery({ messageId: first.messageId }));
    assert.equal(deliveries.length, 1);
    assert.equal(transport.effects.length, 1, "no double delivery");
  });

  it("duplicate retry carries the persisted urgentDowngraded flag (Store-Seam §11.3)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.setDndPolicy({ enabled: true }));

    const command = sendInput(`person:${BOB}`, "downgraded urgent", "w2-2", "urgent");
    const first = unwrap(await alice.sendMessage(command));
    assert.equal(first.urgentDowngraded, true);
    const retry = unwrap(await alice.sendMessage(command));
    assert.equal(retry.duplicate, true);
    assert.equal(retry.urgentDowngraded, true, "the typed outcome survives the retry (MSG-010)");
  });

  it("same clientMessageId with DIFFERENT content → IdempotencyConflict (A5)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    const first = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "original", "w2-3")));
    const conflict = expectError(
      await alice.sendMessage(sendInput(`person:${BOB}`, "tampered", "w2-3")),
    );
    assert.equal(conflict.name, "IdempotencyConflict");
    assert.equal(conflict.retryable, false);
    assert.equal(conflict.fields["clientMessageId"], "w2-3");
    assert.equal(conflict.fields["originalMessageId"], first.messageId);
  });

  it("a retry is never re-judged by policy that changed after acceptance (DEC-13)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    const command = sendInput(`person:${BOB}`, "before the block", "w2-4");
    const first = unwrap(await alice.sendMessage(command));

    // Bob now blocks alice entirely; the retry must still return the ORIGINAL
    // acceptance, not a fresh policy verdict.
    unwrap(await bob.setContactPolicy({ allowlist: [], defaultRule: "deny" }));
    const retry = unwrap(await alice.sendMessage(command));
    assert.equal(retry.duplicate, true);
    assert.equal(retry.messageId, first.messageId);
  });
});
