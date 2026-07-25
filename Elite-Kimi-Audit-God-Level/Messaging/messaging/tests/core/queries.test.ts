/**
 * Queries — the S1 subset under the R3 authorization matrix: GetInbox
 * (non-terminal only, §11.2), GetMessages (sequence-ordered cursor
 * pagination, DEC-19), GetThread/GetDelivery membership, GetPolicy
 * (synthesized DEC-14 defaults; self or policy.admin), GetPresence (any
 * authenticated principal), GetCapabilities (pre-auth discovery; limits
 * copied from constants).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { constants, contractVersion } from "../../public/index.js";
import type { Cursor } from "../../public/index.js";
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

describe("queries (R3 matrix, S1 subset)", () => {
  it("GetInbox serves non-terminal deliveries only", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    const first = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "one", "q-1")));
    assert.deepEqual(
      unwrap(await bob.getInbox({})).messages.map((m) => m.id),
      [first.messageId],
      "pending appears",
    );

    unwrap(await bob.openPresence({ transport: "ws" })); // delivers the pending message
    assert.equal(unwrap(await bob.getInbox({})).messages.length, 0, "delivered never appears (§11.2)");
  });

  it("GetMessages: sequence-ascending cursor pagination (DEC-19); malformed cursor → ValidationFailed", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    const ids: string[] = [];
    let threadId = "";
    for (const [index, text] of ["m1", "m2", "m3"].entries()) {
      const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, text, `q-2-${index}`)));
      ids.push(accepted.messageId);
      threadId = accepted.threadId;
    }

    const page1 = unwrap(await alice.getMessages({ threadId, limit: 2 }));
    assert.deepEqual(page1.messages.map((m) => m.id), [ids[0], ids[1]], "sequence ascending");
    assert.ok(page1.nextCursor, "a next cursor exists");
    assert.ok(page1.messages[0]!.sequence < page1.messages[1]!.sequence);

    const page2 = unwrap(await alice.getMessages({ threadId, cursor: page1.nextCursor, limit: 2 }));
    assert.deepEqual(page2.messages.map((m) => m.id), [ids[2]], "no loss, no duplication");
    assert.equal(page2.nextCursor, undefined);

    const malformed = expectError(await alice.getMessages({ threadId, cursor: "s_abc" as Cursor }));
    assert.equal(malformed.name, "ValidationFailed");
  });

  it("GetThread / GetDelivery: member-only reads under R3, honest Unknown* for absence", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const chief = await sessionFor(cap, "tok-chief");

    await allowlist(bob, ALICE);
    const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "member check", "q-3")));

    // Members read; non-members get NotAuthorized (the accepted R3 existence
    // side-channel: NotAuthorized = exists, not yours; Unknown* = absent).
    unwrap(await alice.getThread({ threadId: accepted.threadId }));
    unwrap(await bob.getDelivery({ messageId: accepted.messageId }));
    assert.equal(
      (expectError(await chief.getThread({ threadId: accepted.threadId }))).name,
      "NotAuthorized",
    );
    assert.equal(
      (expectError(await chief.getDelivery({ messageId: accepted.messageId }))).name,
      "NotAuthorized",
    );

    assert.equal(
      (expectError(await alice.getThread({ threadId: "thread_nope" as never }))).name,
      "UnknownThread",
    );
    assert.equal(
      (expectError(await alice.getDelivery({ messageId: "message_nope" as never }))).name,
      "UnknownMessage",
    );
  });

  it("GetPolicy: synthesized DEC-14 defaults before any write; self or policy.admin (R3)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    const view = unwrap(await bob.getPolicy({}));
    assert.equal(view.contact.defaultRule, "deny", "DEC-14 default deny — first contact is deliberate (A3)");
    assert.deepEqual(view.contact.allowlist, []);
    assert.equal(view.contact.revision, 0, "revision 0 marks the synthesized default (never persisted)");
    assert.equal(view.dnd.enabled, false);
    assert.equal(view.dnd.revision, 0);

    // Another Person's policy requires policy.admin.
    assert.equal(
      (expectError(await alice.getPolicy({ personId: BOB }))).name,
      "NotAuthorized",
    );

    // After a real write, the persisted record shows with revision 1.
    unwrap(await bob.setDndPolicy({ enabled: true }));
    const after = unwrap(await bob.getPolicy({}));
    assert.equal(after.dnd.enabled, true);
    assert.equal(after.dnd.revision, 1);
    assert.equal(after.contact.revision, 0, "the untouched half still shows the default");
  });

  it("GetPresence is observability for any authenticated principal (R3)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    unwrap(await bob.openPresence({ transport: "ws" }));
    const seen = unwrap(await alice.getPresence({ personId: BOB }));
    assert.equal(seen.presences.length, 1, "presence is observability, not addressing");
    assert.equal(seen.presences[0]?.personId, BOB);
  });

  it("GetCapabilities: pre-auth discovery; limits copied from constants (never hand-written)", async () => {
    const { cap } = makeHarness();

    const view = cap.getCapabilities();
    assert.equal(view.contractVersion, contractVersion);
    assert.deepEqual(view.limits, {
      messageMaxBytes: constants.messageMaxBytes,
      pageLimitMax: constants.pageLimitMax,
      subscriptionBufferMax: constants.subscriptionBufferMax,
    });
    assert.ok(view.features.includes("direct"));
    assert.ok(!view.features.includes("rooms"), "rooms are S2 — absent, not advertised");
    assert.ok(view.features.includes("subscribe"), "subscribe landed in S1-c — advertised");
  });

  it("GetInbox for another Person requires policy.admin", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const admin = await sessionFor(cap, "tok-admin");

    await allowlist(bob, ALICE);
    unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "admin-visible", "q-7")));

    assert.equal(
      (expectError(await alice.getInbox({ personId: BOB }))).name,
      "NotAuthorized",
    );
    const adminView = unwrap(await admin.getInbox({ personId: BOB }));
    assert.equal(adminView.messages.length, 1);
    void CHIEF;
  });
});
