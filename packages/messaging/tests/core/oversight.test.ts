/**
 * A-R-N4-1 (contract 1.1.0): the oversight.read grant — lane oversight for
 * the owner (PR #72 ruling: the owner MUST see agent↔agent DM lanes).
 * READ-ONLY: a holder READS any direct Thread regardless of pair membership;
 * send rules (R4 party-only) are untouched.
 *
 * Covers: GetThread/GetMessages/GetDelivery on a foreign direct lane (holder
 * passes, non-holder NotAuthorized), ListThreadsForPerson-for-self gaining
 * every direct lane (and not without the grant), policy.admin listing
 * ANOTHER person gaining NO oversight of unrelated lanes, unscoped
 * subscription payload filtering for foreign lanes (live push), and
 * explicit threads[] scope succeeding with the grant / failing the whole
 * Subscribe without it (G6).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createEmbeddedMessaging,
  createMemoryPresenceTransport,
  createSeededClock,
  cursorFor,
  DEFAULT_ROLE_GRANTS,
} from "../../contract/index.js";
import type {
  MembershipRoomConfig,
  PersonId,
  Sequence,
  SubscriptionMessage,
  SubscriptionSink,
  ThreadId,
} from "../../contract/index.js";
import {
  ADMIN,
  ALICE,
  BOB,
  CHIEF,
  TEST_RETRY_POLICY,
  ManualScheduler,
  allowlist,
  expectError,
  flushMicrotasks,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

/** The lane overseer — holds oversight.read directly (DEC-07: adapter config). */
const OVERSEER = "person_overseer" as PersonId;

/** A room the overseer is NOT a member of (F3's boundary fixture). */
const TEAM_ROOM: MembershipRoomConfig = {
  threadKind: "team",
  authority: "team-capability",
  externalId: "team-oversight",
  members: [ALICE, BOB, CHIEF],
};

/** makeHarness + the overseer principal (the shared helper fixes its own list). */
function makeOversightHarness(rooms?: MembershipRoomConfig[]) {
  const clock = createSeededClock({ seed: "core" });
  const transport = createMemoryPresenceTransport({ kind: "ws" });
  const scheduler = new ManualScheduler();
  const cap = createEmbeddedMessaging({
    clock,
    transports: [transport],
    scheduler,
    retryPolicy: TEST_RETRY_POLICY,
    ...(rooms !== undefined ? { membership: { rooms } } : {}),
    authority: {
      principals: [
        { token: "tok-alice", personId: ALICE, roles: ["Worker"] },
        { token: "tok-bob", personId: BOB, roles: ["Worker"] },
        { token: "tok-chief", personId: CHIEF, roles: ["Chief"] },
        { token: "tok-admin", personId: ADMIN, grants: ["policy.admin"] },
        { token: "tok-overseer", personId: OVERSEER, grants: ["oversight.read"] },
      ],
      roleGrants: DEFAULT_ROLE_GRANTS,
    },
  });
  return { cap };
}

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

/** alice↔bob direct lane with one committed message (chief/overseer are foreign). */
async function foreignLane(cap: ReturnType<typeof createEmbeddedMessaging>) {
  const alice = await sessionFor(cap, "tok-alice");
  const bob = await sessionFor(cap, "tok-bob");
  await allowlist(bob, ALICE);
  const sent = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "lane traffic", "o-1")));
  return { alice, bob, threadId: sent.threadId, messageId: sent.messageId };
}

describe("A-R-N4-1 oversight.read — queries on a foreign direct lane", () => {
  it("GetThread / GetMessages / GetDelivery: the holder READS; a non-holder stays NotAuthorized", async () => {
    const { cap } = makeOversightHarness();
    const { threadId, messageId } = await foreignLane(cap);
    const overseer = await sessionFor(cap, "tok-overseer");
    const chief = await sessionFor(cap, "tok-chief");

    const thread = unwrap(await overseer.getThread({ threadId }));
    assert.equal(thread.id, threadId, "the holder reads a foreign direct Thread");
    const page = unwrap(await overseer.getMessages({ threadId }));
    assert.equal(page.messages.length, 1, "the holder pages the foreign lane's history");
    const deliveries = unwrap(await overseer.getDelivery({ messageId }));
    assert.ok(deliveries.deliveries.length >= 1, "the holder reads the foreign delivery truth");

    for (const read of [
      () => chief.getThread({ threadId }),
      () => chief.getMessages({ threadId }),
      () => chief.getDelivery({ messageId }),
    ]) {
      const denied = await read();
      assert.equal(denied.kind, "error", "a non-holder stays party-only (R3)");
      if (denied.kind === "error") assert.equal(denied.error.name, "NotAuthorized");
    }
    await cap.close();
  });

  it("ListThreadsForPerson for SELF: the grant adds every direct lane; without it the lane stays invisible", async () => {
    const { cap } = makeOversightHarness();
    const { threadId } = await foreignLane(cap);
    const overseer = await sessionFor(cap, "tok-overseer");
    const chief = await sessionFor(cap, "tok-chief");

    const overseerThreads = unwrap(await overseer.listThreadsForPerson({}));
    assert.ok(
      overseerThreads.threads.some((thread) => thread.id === threadId),
      "the holder's self-list includes the foreign direct lane",
    );
    const chiefThreads = unwrap(await chief.listThreadsForPerson({}));
    assert.ok(
      !chiefThreads.threads.some((thread) => thread.id === threadId),
      "a non-holder's self-list stays pair-scoped (§11.5)",
    );
    await cap.close();
  });

  it("policy.admin listing ANOTHER person gains NO oversight of unrelated lanes", async () => {
    const { cap } = makeOversightHarness();
    const { threadId } = await foreignLane(cap); // alice↔bob — unrelated to chief
    const chief = await sessionFor(cap, "tok-chief");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, CHIEF);
    const chiefLane = unwrap(await chief.sendMessage(sendInput(`person:${BOB}`, "chief lane", "o-2")));
    const admin = await sessionFor(cap, "tok-admin");

    const forChief = unwrap(await admin.listThreadsForPerson({ personId: CHIEF }));
    assert.ok(
      forChief.threads.some((thread) => thread.id === chiefLane.threadId),
      "the pair-scoped read still serves the target's own lane",
    );
    assert.ok(
      !forChief.threads.some((thread) => thread.id === threadId),
      "acting for another NEVER leaks unrelated lanes (oversight is self-list only)",
    );
    await cap.close();
  });
});

describe("A-R-N4-1 oversight.read — subscriptions on a foreign direct lane", () => {
  it("unscoped: the holder receives MessageCommitted + DeliveryUpdated for the foreign lane (live push)", async () => {
    const { cap } = makeOversightHarness();
    const overseer = await sessionFor(cap, "tok-overseer");
    const { sink, frames } = collectSink();
    unwrap(await overseer.subscribe({ events: ["MessageCommitted", "DeliveryUpdated"] }, sink));

    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowlist(bob, ALICE);
    unwrap(await bob.openPresence({ transport: "ws" })); // lets the delivery settle
    unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "watched lane", "o-3")));
    await cap.pumpEvents();
    await flushMicrotasks();

    const events = frames.filter((frame) => frame.kind === "event");
    const kinds = events.map((frame) => Object.keys(frame.event as Record<string, unknown>));
    assert.ok(
      kinds.some((keys) => keys.includes("message")),
      "MessageCommitted for the foreign lane reaches the holder",
    );
    assert.ok(
      kinds.some((keys) => keys.includes("delivery")),
      "DeliveryUpdated for the foreign lane reaches the holder",
    );
    await cap.close();
  });

  it("explicit threads[] scope: succeeds with the grant, fails the WHOLE Subscribe without it (G6)", async () => {
    const { cap } = makeOversightHarness();
    const { threadId } = await foreignLane(cap);
    const overseer = await sessionFor(cap, "tok-overseer");
    const chief = await sessionFor(cap, "tok-chief");

    const { sink } = collectSink();
    const scoped = unwrap(
      await overseer.subscribe({ events: ["MessageCommitted"], threads: [threadId as ThreadId] }, sink),
    );
    assert.ok(scoped.subscriptionId.startsWith("subscription_"), "the holder scopes a foreign lane explicitly");

    const denied = expectError(
      await chief.subscribe({ events: ["MessageCommitted"], threads: [threadId as ThreadId] }, collectSink().sink),
    );
    assert.equal(denied.name, "NotAuthorized", "a non-holder's foreign scope fails the whole Subscribe");
    await cap.close();
  });

  it("F4: replay — a since-cursor subscription delivers foreign-lane history to the holder", async () => {
    const { cap } = makeOversightHarness();
    // The lane commits traffic BEFORE the subscription exists — this is the
    // replay path (journal scan from the cursor), not the live push.
    const { threadId } = await foreignLane(cap);
    const overseer = await sessionFor(cap, "tok-overseer");
    const { sink, frames } = collectSink();
    unwrap(await overseer.subscribe({ events: ["MessageCommitted"], since: cursorFor(0 as Sequence) }, sink));
    await cap.pumpEvents();
    await flushMicrotasks();

    const replayed = frames.filter((frame) => frame.kind === "event").some((frame) => {
      const payload = frame.event as { message?: { threadId: string; body: { text: string } } };
      return payload.message?.threadId === threadId && payload.message.body.text === "lane traffic";
    });
    assert.ok(replayed, "the foreign lane's committed history REPLAYS to the holder (A-R-N4-1)");
    await cap.close();
  });
});

describe("A-R-N4-1 — the boundaries the grant does NOT cross", () => {
  it("F1: a non-holder's list order is the store's interleaved creation order (§11.5)", async () => {
    const { cap } = makeOversightHarness([TEAM_ROOM]);
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const chief = await sessionFor(cap, "tok-chief");
    await allowlist(bob, ALICE);
    await allowlist(chief, ALICE);

    // direct lane, then a room alice belongs to, then another direct lane —
    // the list must stay interleaved, never directs-then-rooms.
    const lane1 = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "lane one", "f1-1")));
    const roomOutcome = await cap.store.createRoomThread({
      threadKind: "team", authority: "team-capability", externalId: "team-oversight",
    });
    if (roomOutcome.kind !== "ok") throw new Error("unreachable");
    const room = roomOutcome.value;
    const lane2 = unwrap(await alice.sendMessage(sendInput(`person:${CHIEF}`, "lane two", "f1-2")));

    const listed = unwrap(await alice.listThreadsForPerson({}));
    assert.deepEqual(
      listed.threads.map((thread) => thread.id),
      [lane1.threadId, room.id, lane2.threadId],
      "non-holder output is byte-identical to the pre-amendment interleaved order",
    );
    await cap.close();
  });

  it("F3: the grant never bleeds into rooms — foreign room reads stay NotAuthorized", async () => {
    const { cap } = makeOversightHarness([TEAM_ROOM]);
    await cap.start(); // Store-Seam §11.4 provisioning creates the room Thread
    const alice = await sessionFor(cap, "tok-alice");
    const listed = unwrap(await alice.listThreadsForPerson({}));
    const room = listed.threads.find((thread) => thread.threadKind === "team");
    assert.ok(room, "the member sees the provisioned room Thread");
    const overseer = await sessionFor(cap, "tok-overseer");

    const read = expectError(await overseer.getThread({ threadId: room.id }));
    assert.equal(read.name, "NotAuthorized", "oversight.read is direct-lane-only — rooms keep R3 membership");

    const scoped = expectError(
      await overseer.subscribe({ events: ["MessageCommitted"], threads: [room.id] }, collectSink().sink),
    );
    assert.equal(scoped.name, "NotAuthorized", "explicit scope on a foreign room fails the whole Subscribe");
    await cap.close();
  });
});
