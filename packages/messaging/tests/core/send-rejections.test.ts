/**
 * Send-path rejections, all typed (G6): contact policy (DEC-14, A3, R4),
 * unknown recipient (MSG-014), oversize (R13), payload spoofing (MSG-020),
 * grant-gated policy writes (policy.admin), thread:-addressed direct sends
 * (R4/DEC-03 pair membership).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { constants, createEmbeddedMessaging, createMemoryStore, createSeededClock } from "../../contract/index.js";
import { DEFAULT_ROLE_GRANTS } from "../../contract/index.js";
import {
  ALICE,
  BOB,
  STRANGER,
  allowlist,
  expectError,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

describe("send-path typed rejections", () => {
  it("blocked contact → BlockedByContactPolicy (DEC-14 default deny: first contact is deliberate)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    await sessionFor(cap, "tok-bob");

    // No ContactPolicy record at all ≡ DEC-14 default {allowlist: [], deny} (A3).
    const blocked = expectError(
      await alice.sendMessage(sendInput(`person:${BOB}`, "cold call", "rej-1")),
    );
    assert.equal(blocked.name, "BlockedByContactPolicy");
    assert.equal(blocked.fields["recipientId"], BOB);

    // The recipient allowlists the sender → the same send now accepts.
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);
    const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "warm call", "rej-2")));
    assert.ok(accepted.messageId);
  });

  it("shared Thread implies allow: the reply path needs no policy change (DEC-14)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    await allowlist(bob, ALICE);
    const first = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "first contact", "rej-3")));

    // Alice never set any policy; bob replies over the now-shared direct Thread.
    const reply = unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "reply", "rej-4")));
    assert.ok(reply.messageId);
    assert.equal(reply.threadId, first.threadId, "one canonical direct Thread per pair (DEC-03)");
  });

  it("unknown recipient → UnknownRecipient (MSG-014)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    const error = expectError(
      await alice.sendMessage(sendInput(`person:${STRANGER}`, "anyone?", "rej-5")),
    );
    assert.equal(error.name, "UnknownRecipient");
    assert.equal(error.fields["address"], `person:${STRANGER}`);
  });

  it("oversize message → ValidationFailed (R13, constants.messageMaxBytes)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);

    const error = expectError(
      await alice.sendMessage(
        sendInput(`person:${BOB}`, "x".repeat(constants.messageMaxBytes), "rej-6"),
      ),
    );
    assert.equal(error.name, "ValidationFailed");
  });

  it("caller-supplied sender fields are rejected at the door (MSG-020, DEC-11)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);

    const spoof = { ...sendInput(`person:${BOB}`, "trust me", "rej-7"), from: `person:${BOB}` };
    const error = expectError(await alice.sendMessage(spoof));
    assert.equal(error.name, "ValidationFailed");

    const spoof2 = { ...sendInput(`person:${BOB}`, "trust me", "rej-8"), senderId: `person:${BOB}` };
    assert.equal((expectError(await alice.sendMessage(spoof2))).name, "ValidationFailed");
  });

  it("unauthorized sender (no grant): another Person's policy requires policy.admin", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    const error = expectError(
      await alice.setContactPolicy({ personId: BOB, allowlist: [], defaultRule: "allow" }),
    );
    assert.equal(error.name, "NotAuthorized");
    assert.equal(error.fields["requiredGrant"], "policy.admin");

    const dndError = expectError(await alice.setDndPolicy({ personId: BOB, enabled: true }));
    assert.equal(dndError.name, "NotAuthorized");

    // The admin principal (explicit policy.admin grant) may act for others.
    const admin = await sessionFor(cap, "tok-admin");
    const updated = unwrap(
      await admin.setDndPolicy({ personId: BOB, enabled: true }),
    );
    assert.equal(updated.revision, 1);
    const view = unwrap(await admin.getPolicy({ personId: BOB }));
    assert.equal(view.dnd.enabled, true);
  });

  it("thread:-addressed direct sends: pair membership required, recipient is the other member (R4)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const chief = await sessionFor(cap, "tok-chief");

    await allowlist(bob, ALICE);
    const first = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "seed thread", "rej-9")));

    // A stranger to the pair cannot post into the direct Thread (DEC-03 holds).
    const stranger = expectError(
      await chief.sendMessage(sendInput(`thread:${first.threadId}`, "intruder", "rej-10")),
    );
    assert.equal(stranger.name, "NotAuthorized");

    // A pair member can; the recipient is the other member.
    const reply = unwrap(
      await bob.sendMessage(sendInput(`thread:${first.threadId}`, "member reply", "rej-11")),
    );
    assert.equal(reply.threadId, first.threadId);
    const { deliveries } = unwrap(await alice.getDelivery({ messageId: reply.messageId }));
    assert.equal(deliveries[0]?.recipientId, ALICE);

    // Unknown thread IDs are UnknownThread, not NotAuthorized (R3 matrix).
    const unknown = expectError(
      await alice.sendMessage(sendInput("thread:thread_nope", "hello?", "rej-12")),
    );
    assert.equal(unknown.name, "UnknownThread");
  });

  it("F9: commitAcceptance failed{RecordNotFound} maps to UnknownThread — never a thrown core bug", async () => {
    // The store-seam RecordNotFound is context-dependent (Store-Seam §6);
    // routing it through storeDependencyError THROWS by design (the S2 trap:
    // a room-thread acceptance for a thread that does not exist). Rig the
    // store to fail the commit that way and assert the send path returns
    // SendMessage's honest typed outcome instead of rejecting the promise.
    const clock = createSeededClock({ seed: "f9" });
    const inner = createMemoryStore(clock);
    const rigged = Object.create(inner) as typeof inner;
    rigged.commitAcceptance = () =>
      Promise.resolve({
        kind: "failed",
        error: { name: "RecordNotFound", record: "thread", id: "thread_gone" },
      });
    const cap = createEmbeddedMessaging({
      clock,
      store: rigged,
      authority: {
        principals: [{ token: "tok-alice", personId: ALICE, roles: ["Worker"] }],
        roleGrants: DEFAULT_ROLE_GRANTS,
      },
    });
    const alice = await sessionFor(cap, "tok-alice");
    const outcome = await alice.sendMessage(sendInput(`person:${ALICE}`, "room lane", "f9-1"));
    const error = expectError(outcome); // pre-fix this promise REJECTED (core bug throw)
    assert.equal(error.name, "UnknownThread");
    assert.equal(error.fields["threadId"], "thread_gone");
    await cap.close();
  });
});
