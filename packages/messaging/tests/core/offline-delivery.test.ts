/**
 * Offline delivery and the R5 no-presence rule: zero live Presences leaves the
 * Delivery pending — never failed, nothing to retry against — and each
 * PresenceChanged(opened) re-triggers an attempt decision. Also the
 * presence-gone mid-effect path (Seams §4.1): attempt records failure, the
 * presence closes via the single close path, the Delivery stays pending.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  ALICE,
  BOB,
  allowlist,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

describe("offline delivery (R5 no-presence rule)", () => {
  it("offline recipient → pending (not failed, no attempts) → presence open → delivered", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "you there?", "off-1")),
    );

    const before = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(before.deliveries[0]?.state, "pending", "pending — never failed (O1: no expiry)");
    assert.equal(before.deliveries[0]?.stateReason, undefined);
    assert.equal(transport.attempts.length, 0, "nothing to retry against while offline");

    // Still pullable while pending (GetInbox serves non-terminal deliveries).
    assert.equal(unwrap(await bob.getInbox({})).messages.length, 1);

    // PresenceChanged(opened) re-triggers the attempt decision.
    unwrap(await bob.openPresence({ transport: "ws" }));
    const after = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(after.deliveries[0]?.state, "delivered");
    assert.equal(after.deliveries[0]?.stateReason, "adapter-effect");
    assert.equal(transport.effects.length, 1);
  });

  it("presence-gone mid-effect: presence closes, delivery stays pending (Seams §4.1)", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws" }));
    transport.setDeliverScript(() => ({
      kind: "failure",
      retryable: true,
      detail: "socket died mid-write",
      permanent: "presence-gone",
    }));

    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "into a dying socket", "off-2")),
    );

    const { deliveries } = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries[0]?.state, "pending", "no retries burnt against a corpse");
    assert.equal(
      unwrap(await bob.getPresence({ personId: BOB })).presences.length,
      0,
      "the dead presence closed via the single close path",
    );

    // A fresh presence re-triggers and (script cleared) delivers.
    transport.setDeliverScript(undefined);
    unwrap(await bob.openPresence({ transport: "ws" }));
    assert.equal(
      unwrap(await bob.getDelivery({ messageId: accepted.messageId })).deliveries[0]?.state,
      "delivered",
    );
  });

  it("self-send: the (me, me) personal lane delivers to one's own presence (Plan §8)", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    unwrap(await alice.openPresence({ transport: "ws" }));
    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${ALICE}`, "note to self", "off-3")),
    );

    const { deliveries } = unwrap(await alice.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.recipientId, ALICE);
    assert.equal(deliveries[0]?.state, "delivered");
    assert.equal(transport.effects.length, 1);

    const thread = unwrap(await alice.getThread({ threadId: accepted.threadId }));
    assert.deepEqual(thread.direct?.pair, [ALICE, ALICE]);
  });
});
