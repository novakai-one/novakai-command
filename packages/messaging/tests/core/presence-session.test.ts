/**
 * Presence lifecycle (R9) and session revalidation (Seams §2.1).
 *
 * R9: explicit OpenPresence is the ONLY registration mechanism; duplicate
 * opens mint a new Presence each time; every close funnels through the single
 * close path (graceful, disconnect, liveness timeout); ClosePresence is
 * idempotent and owner-scoped (or policy.admin).
 *
 * §2.1: revalidate → unavailable degrades (operations fail
 * DependencyUnavailable{authority, retryable: true}; the Presence stays open);
 * revalidate → invalid ends the session; degraded past the grace period is
 * treated as invalid.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import type { SubscriptionMessage, SubscriptionSink } from "../../public/index.js";
import {
  ALICE,
  BOB,
  expectError,
  flushMicrotasks,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

describe("presence lifecycle (R9)", () => {
  it("authentication alone never registers; duplicate opens mint new Presences", async () => {
    const { cap } = makeHarness();
    const bob = await sessionFor(cap, "tok-bob");

    assert.equal(
      unwrap(await bob.getPresence({ personId: BOB })).presences.length,
      0,
      "authenticated but not present (R9)",
    );

    const first = unwrap(await bob.openPresence({ transport: "ws", clientLabel: "term-1" }));
    const second = unwrap(await bob.openPresence({ transport: "ws", clientLabel: "term-2" }));
    assert.notEqual(first.presenceId, second.presenceId, "duplicate opens are allowed (DEC-02)");

    const presences = unwrap(await bob.getPresence({ personId: BOB })).presences;
    assert.equal(presences.length, 2);
    assert.deepEqual(
      presences.map((p) => p.id).sort(),
      [first.presenceId, second.presenceId].sort(),
    );
    assert.equal(presences.find((p) => p.id === first.presenceId)?.clientLabel, "term-1");
  });

  it("OpenPresence naming an unregistered transport fails ValidationFailed (Seams §4 composition rule)", async () => {
    const { cap } = makeHarness();
    const bob = await sessionFor(cap, "tok-bob");

    const error = expectError(await bob.openPresence({ transport: "pty" }));
    assert.equal(error.name, "ValidationFailed");
  });

  it("disconnect and liveness timeout close through the single close path", async () => {
    const { cap, transport } = makeHarness();
    const bob = await sessionFor(cap, "tok-bob");

    const first = unwrap(await bob.openPresence({ transport: "ws" }));
    const second = unwrap(await bob.openPresence({ transport: "ws" }));

    transport.simulateDisconnect(first.presenceId);
    assert.deepEqual(
      unwrap(await bob.getPresence({ personId: BOB })).presences.map((p) => p.id),
      [second.presenceId],
    );

    transport.simulateLivenessTimeout(second.presenceId);
    assert.equal(unwrap(await bob.getPresence({ personId: BOB })).presences.length, 0);
  });

  it("ClosePresence: idempotent, owner-scoped, policy.admin override", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const admin = await sessionFor(cap, "tok-admin");

    const mine = unwrap(await bob.openPresence({ transport: "ws" }));
    const other = unwrap(await bob.openPresence({ transport: "ws" }));

    // Another Person cannot close it.
    const denied = expectError(await alice.closePresence({ presenceId: mine.presenceId }));
    assert.equal(denied.name, "NotAuthorized");

    // The owner can.
    unwrap(await bob.closePresence({ presenceId: mine.presenceId }));
    // Closing again (already closed) succeeds — idempotent (R9).
    unwrap(await bob.closePresence({ presenceId: mine.presenceId }));
    // Closing a never-known presence succeeds too.
    unwrap(await bob.closePresence({ presenceId: "presence_neverexisted" as never }));

    // policy.admin may close another Person's presence.
    unwrap(await admin.closePresence({ presenceId: other.presenceId }));
    assert.equal(unwrap(await bob.getPresence({ personId: BOB })).presences.length, 0);
  });
});

describe("session revalidation (Seams §2.1)", () => {
  it("degraded: operations fail DependencyUnavailable{authority}; the Presence stays open; recovery resumes", async () => {
    const { cap, authority } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");

    unwrap(await alice.openPresence({ transport: "ws" }));

    authority.setUnavailable(true);
    assert.equal(await alice.revalidate(), "degraded");

    const error = expectError(
      await alice.sendMessage(sendInput(`person:${ALICE}`, "during outage", "sess-1")),
    );
    assert.equal(error.name, "DependencyUnavailable");
    assert.equal(error.fields["dependency"], "authority");
    assert.equal(error.fields["retryable"], true);
    assert.equal(error.retryable, true);

    // EVERY new operation on the degraded session fails (§2.1)…
    assert.equal((expectError(await alice.getInbox({}))).name, "DependencyUnavailable");
    // …but the session is NOT ended: the Presence stays open — observed via
    // another principal (GetPresence is observability, R3).
    assert.equal(unwrap(await bob.getPresence({ personId: ALICE })).presences.length, 1);

    // The authority recovers; a revalidate refreshes the session.
    authority.setUnavailable(false);
    assert.equal(await alice.revalidate(), "active");
    const accepted = unwrap(
      await alice.sendMessage(sendInput(`person:${ALICE}`, "after recovery", "sess-2")),
    );
    assert.ok(accepted.messageId);
  });

  it("invalid: the session ends; every operation fails NotAuthenticated", async () => {
    const { cap, authority } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    authority.invalidateSession(alice.principal.sessionId);
    assert.equal(await alice.revalidate(), "ended");

    const error = expectError(
      await alice.sendMessage(sendInput(`person:${ALICE}`, "after invalidation", "sess-3")),
    );
    assert.equal(error.name, "NotAuthenticated");
    assert.equal((expectError(await alice.getInbox({}))).name, "NotAuthenticated");
  });

  it("degraded past the grace period is treated as invalid (§2.1, v1 default 5 min)", async () => {
    const { cap, clock, authority } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    authority.setUnavailable(true);
    assert.equal(await alice.revalidate(), "degraded");

    clock.advance(6 * 60 * 1000); // past the 5-minute grace period
    const error = expectError(
      await alice.sendMessage(sendInput(`person:${ALICE}`, "after grace", "sess-4")),
    );
    assert.equal(error.name, "NotAuthenticated");
    assert.equal(alice.state, "ended");
  });

  it("F3: ended is terminal (no resurrection) and grace elapse ends the session on the revalidation path (clock-driven)", async () => {
    const { cap, clock, authority } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    // The subscription proves onEnded fires from the TIMER path (ended{auth-lost}),
    // with no operation ever crossing the session guard.
    const frames: SubscriptionMessage[] = [];
    const sink: SubscriptionSink = async (frame) => {
      frames.push(frame);
      return { kind: "effect" };
    };
    unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));

    authority.setUnavailable(true);
    assert.equal(await alice.revalidate(), "degraded");

    // Past the 5-minute grace with the authority still down: the revalidation
    // path itself (what the composition's timer drives) ends the session —
    // an idle subscribed session must not flow past grace (Seams §2.1).
    clock.advance(6 * 60 * 1000);
    assert.equal(
      await alice.revalidate(),
      "ended",
      "F3: grace is clock-driven — the timer path ends the session, not just guard()",
    );
    await flushMicrotasks();
    const ended = frames.filter((frame) => frame.kind === "ended");
    assert.deepEqual(
      ended.map((frame) => (frame as { reason: string }).reason),
      ["auth-lost"],
      "onEnded fired from the revalidation path — subscriptions stop at the grace boundary",
    );

    // F3: ended is TERMINAL — a later `valid` revalidation must not resurrect.
    authority.setUnavailable(false);
    assert.equal(await alice.revalidate(), "ended", "no transition out of ended, ever");
    const error = expectError(
      await alice.sendMessage(sendInput(`person:${ALICE}`, "resurrection attempt", "f3-1")),
    );
    assert.equal(error.name, "NotAuthenticated", "a resurrected session would have sent");
    await cap.close();
  });

  it("session expiry triggers a lazy revalidation (§2.1 revalidation owner)", async () => {
    const { cap, clock, authority } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    // Within TTL: fine. Past TTL: the authority reports the session invalid.
    clock.advance(61 * 60 * 1000);
    const error = expectError(
      await alice.sendMessage(sendInput(`person:${ALICE}`, "stale session", "sess-5")),
    );
    assert.equal(error.name, "NotAuthenticated");
    assert.equal(alice.state, "ended");
    void authority;
  });

  it("bad credentials are rejected; a down authority is unavailable (§2.2)", async () => {
    const { cap, authority } = makeHarness();

    const rejected = await cap.authenticate({ token: "tok-nobody" });
    assert.equal(rejected.kind, "rejected");
    if (rejected.kind === "rejected") assert.equal(rejected.error.name, "NotAuthenticated");

    const malformed = await cap.authenticate("not-even-an-object");
    assert.equal(malformed.kind, "rejected");

    authority.setUnavailable(true);
    const down = await cap.authenticate({ token: "tok-alice" });
    assert.equal(down.kind, "unavailable");
    if (down.kind === "unavailable") {
      assert.equal(down.error.name, "DependencyUnavailable");
      assert.equal(down.error.fields["dependency"], "authority");
    }
  });
});
