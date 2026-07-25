/**
 * W1 — urgent send against DND, without and with override authority
 * (Plan §16 W1; DEC-07, DEC-08, I9, MSG-008/009/010; R5 DND hold/release).
 *
 * Also covers the R5 policyEvaluation ruling: DND is re-evaluated at EVERY
 * attempt decision point against CURRENT policy — enabling DND after
 * acceptance still holds the push at the presence-open re-trigger.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import type { SendAccepted } from "../../public/index.js";
import {
  ALICE,
  BOB,
  CHIEF,
  allowlist,
  expectError,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

describe("W1 — urgent vs DND (R5)", () => {
  it("urgent without the override grant downgrades with a typed outcome and holds (MSG-009/010)", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    unwrap(await bob.setDndPolicy({ enabled: true }));
    // Bob is ONLINE — DND holds the push anyway (attention, not access).
    unwrap(await bob.openPresence({ transport: "ws" }));

    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "urgent: deploy is red", "w1-1", "urgent")),
    );
    assert.equal(accepted.urgentDowngraded, true, "typed downgrade, never silent (MSG-010)");
    assert.equal(accepted.duplicate, undefined);

    const { deliveries } = unwrap(await alice.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.state, "held");
    assert.equal(deliveries[0]?.stateReason, "dnd-hold");
    assert.equal(transport.effects.length, 0, "no effect while held (DEC-08)");

    // Held, not lost: pullable via GetInbox (guarantee 6 — DND holds attention, never access).
    const inbox = unwrap(await bob.getInbox({}));
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0]?.id, accepted.messageId);
    assert.equal(inbox.messages[0]?.priority, "urgent", "the priority field never rewrites");

    // R5 dnd-released: SetDndPolicy(false) releases the hold; attempts resume.
    unwrap(await bob.setDndPolicy({ enabled: false }));
    const after = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(after.deliveries[0]?.state, "delivered");
    assert.equal(after.deliveries[0]?.stateReason, "adapter-effect");
    assert.equal(transport.effects.length, 1, "real adapter effect settled it (I11)");

    // Terminal deliveries leave the inbox (Store-Seam §11.2).
    assert.equal(unwrap(await bob.getInbox({})).messages.length, 0);
  });

  it("urgent WITH priority.override skips held entirely (DEC-07, I9)", async () => {
    const { cap, transport } = makeHarness();
    const chief = await sessionFor(cap, "tok-chief");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, CHIEF);
    unwrap(await bob.setDndPolicy({ enabled: true }));
    unwrap(await bob.openPresence({ transport: "ws" }));

    const accepted: SendAccepted = unwrap(
      await chief.sendMessage(sendInput(`person:${BOB}`, "chief: need you now", "w1-2", "urgent")),
    );
    assert.equal(accepted.urgentDowngraded, undefined, "no downgrade with the grant");

    const { deliveries } = unwrap(await chief.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries[0]?.state, "delivered");
    assert.equal(deliveries[0]?.stateReason, "adapter-effect");
    assert.equal(transport.effects.length, 1);
    assert.equal(transport.effects[0]?.payload.priority, "urgent");
  });

  it("DND enabled AFTER acceptance still holds the push (R5 policyEvaluation)", async () => {
    const { cap, transport } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    // DND off at acceptance; bob offline → delivery pending.
    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${BOB}`, "normal note", "w1-3")),
    );
    assert.equal(unwrap(await bob.getDelivery({ messageId: accepted.messageId })).deliveries[0]?.state, "pending");

    // Bob enables DND, THEN opens presence — the re-trigger re-evaluates
    // CURRENT policy and moves pending → held instead of attempting.
    unwrap(await bob.setDndPolicy({ enabled: true }));
    unwrap(await bob.openPresence({ transport: "ws" }));

    const { deliveries } = unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries[0]?.state, "held");
    assert.equal(deliveries[0]?.stateReason, "dnd-hold");
    assert.equal(transport.effects.length, 0);
  });
});
