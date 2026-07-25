/**
 * S2 (Rooms) proofs through the public door (embedded composition root):
 *
 *  - MSG-002/003: one Message to a team/mission destination → one Message,
 *    one Thread, one Delivery per snapshotted member (DEC-05).
 *  - I5: a membership change after acceptance never rewrites the frozen
 *    RecipientSnapshot or its Deliveries (snapshot evidence via the
 *    composition-owned store handle — no public query exposes snapshots).
 *  - R4: sender non-member → NotAuthorized; a blocked room recipient gets a
 *    terminal failed Delivery (blocked-by-contact-policy) AT ACCEPTANCE, the
 *    send itself is accepted, BlockedByContactPolicy never fires on rooms,
 *    and the blocked recipient's inbox never serves the Message (§11.2).
 *  - R8: exactly ONE membership resolution per room send (no second isMember
 *    on the send path), revision evidence frozen with the snapshot, sender
 *    checked from the SAME resolution.
 *  - R3: room authorization on GetThread / GetMessages / ListThreadsForPerson
 *    / Subscribe — member vs non-member, unknown room, membership outage.
 *  - R5 on rooms: per-recipient DND hold/release and the MSG-010
 *    urgentDowngraded flag.
 *
 * Room Threads are provisioned two ways, both sanctioned (Store-Seam §11.4):
 * a MembershipConfig through the stack's start() provisioning (the v1
 * capability-to-capability shape), and the composition-owned store handle's
 * createRoomThread (the mechanism a second capability drives — P4's S2-b
 * half).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConfigMembership, createSeededClock, unknownRoom } from "../../public/index.js";
import type {
  ClientMessageId,
  ConfigMembership,
  Cursor,
  IsMemberOutcome,
  MembershipEvidence,
  MembershipRoomConfig,
  MembershipSource,
  MessageId,
  MessagingSession,
  PersonId,
  ResolveMembersOutcome,
  RoomRef,
  SubscriptionMessage,
  SubscriptionSink,
  Thread,
  Timestamp,
} from "../../public/index.js";
import {
  ADMIN,
  ALICE,
  BOB,
  CHIEF,
  expectError,
  flushMicrotasks,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";
import type { Harness } from "./helpers.js";

const TEAM: MembershipRoomConfig = {
  threadKind: "team",
  authority: "team-capability",
  externalId: "team-1",
  members: [ALICE, BOB, CHIEF],
};
const MISSION: MembershipRoomConfig = {
  threadKind: "mission",
  authority: "mission-capability",
  externalId: "mission-1",
  members: [ALICE, BOB, CHIEF],
};

/** A collecting subscription sink (healthy lane: every push reports an effect). */
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

async function makeRoomHarness(rooms: MembershipRoomConfig[] = [TEAM, MISSION]) {
  const harness = makeHarness({ membership: { rooms } });
  await harness.cap.start(); // Store-Seam §11.4 provisioning
  return harness;
}

/** Discover a provisioned room Thread through the public query (as its owner would). */
async function roomThread(
  session: MessagingSession,
  threadKind: "team" | "mission",
): Promise<Thread> {
  const listed = unwrap(await session.listThreadsForPerson({}));
  const found = listed.threads.find((thread) => thread.threadKind === threadKind);
  assert.ok(found, `a ${threadKind} room Thread is visible to the member`);
  return found;
}

/** The members allow the sender (first contact is deliberate, DEC-14). */
async function allowRoomSender(
  cap: Harness["cap"],
  sender: PersonId,
  ...memberTokens: string[]
): Promise<void> {
  for (const token of memberTokens) {
    const session = await sessionFor(cap, token);
    unwrap(await session.setContactPolicy({ allowlist: [sender], defaultRule: "deny" }));
  }
}

/**
 * Poll until alice's acceptance for clientMessageId is durably committed —
 * used with the F4 effectLegDelayMs knob to park INSIDE the commit→settle
 * window (the effect leg is still fault-injected-parked at this point).
 */
async function waitForCommit(cap: Harness["cap"], clientMessageId: string): Promise<MessageId> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = await cap.store.findAcceptance(ALICE, clientMessageId as ClientMessageId);
    if (found.kind === "ok") return found.value.messageId;
    assert.ok(Date.now() < deadline, `acceptance ${clientMessageId} never committed`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("S2 rooms — MSG-002/003 proof shape (DEC-04/05)", () => {
  it("one Message to a team destination → one Message, one Thread, one Delivery per snapshotted member", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    await allowRoomSender(cap, ALICE, "tok-bob", "tok-chief");

    const room = await roomThread(alice, "team");
    assert.equal(room.room?.authority, "team-capability");
    assert.equal(room.room?.externalId, "team-1");

    const sent = unwrap(await alice.sendMessage(sendInput(`thread:${room.id}`, "standup in 5", "rm-1")));
    assert.equal(sent.threadId, room.id);

    const history = unwrap(await alice.getMessages({ threadId: room.id }));
    assert.equal(history.messages.length, 1, "ONE Message in the room Thread");
    assert.equal(history.messages[0]?.senderId, ALICE);
    assert.equal(history.messages[0]?.id, sent.messageId);

    const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    assert.equal(deliveries.deliveries.length, 3, "one Delivery per snapshotted member");
    assert.deepEqual(
      deliveries.deliveries.map((delivery) => delivery.recipientId).sort(),
      [ALICE, BOB, CHIEF].sort(),
      "the resolved member set IS the recipient set — sender included (the (me,me) lane precedent)",
    );
    assert.ok(
      deliveries.deliveries.every((delivery) => delivery.state === "pending"),
      "no presences open → all pending (R5 no-presence rule), none failed",
    );

    // The frozen snapshot (composition-owned store handle — §11.6): the
    // member set + the R8 membership evidence, frozen together.
    const snapshot = await cap.store.getSnapshot(sent.messageId);
    assert.equal(snapshot.kind, "ok");
    if (snapshot.kind === "ok") {
      assert.deepEqual([...snapshot.value.recipients].sort(), [ALICE, BOB, CHIEF].sort());
      assert.equal(snapshot.value.blocked, undefined, "nobody blocked → no blocked list");
      assert.equal(snapshot.value.membership?.authority, "team-capability");
      assert.ok(snapshot.value.membership?.revision, "revision evidence frozen with the snapshot (R8)");
      assert.ok(snapshot.value.membership?.resolvedAt);
    }

    // The sender's own Delivery makes the message visible in their inbox.
    const inbox = unwrap(await alice.getInbox({}));
    assert.ok(inbox.messages.some((message) => message.id === sent.messageId));
    await cap.close();
  });

  it("MSG-003: a mission destination behaves identically (mission room kind)", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    await allowRoomSender(cap, ALICE, "tok-bob", "tok-chief");

    const mission = await roomThread(alice, "mission");
    assert.equal(mission.threadKind, "mission");

    const sent = unwrap(await alice.sendMessage(sendInput(`thread:${mission.id}`, "launch", "rm-2")));
    const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    assert.equal(deliveries.deliveries.length, 3);

    const snapshot = await cap.store.getSnapshot(sent.messageId);
    assert.equal(snapshot.kind, "ok");
    if (snapshot.kind === "ok") {
      assert.equal(snapshot.value.membership?.authority, "mission-capability");
    }
    await cap.close();
  });

  it("I5: a membership change after acceptance never rewrites the snapshot or its Deliveries", async () => {
    // A mutable membership roster (the owning capability's truth CHANGES) —
    // passed as a ready MembershipSource, so the host provisions the room
    // Thread itself via the §11.4 mechanism (the P4 capability shape).
    const roster = { members: [ALICE, BOB, CHIEF] as PersonId[], revision: 1 };
    const membership = stubMembership("team-capability", "team-1", roster);
    const { cap } = makeHarness({ membership });
    const created = await cap.store.createRoomThread({
      threadKind: "team",
      authority: "team-capability",
      externalId: "team-1",
    });
    assert.equal(created.kind, "ok");
    if (created.kind !== "ok") return;
    const roomId = created.value.id;

    const alice = await sessionFor(cap, "tok-alice");
    await allowRoomSender(cap, ALICE, "tok-bob", "tok-chief");
    const first = unwrap(await alice.sendMessage(sendInput(`thread:${roomId}`, "v1 roster", "rm-3")));
    const beforeSnapshot = await cap.store.getSnapshot(first.messageId);
    assert.equal(beforeSnapshot.kind, "ok");
    if (beforeSnapshot.kind !== "ok") return;
    assert.equal(beforeSnapshot.value.recipients.length, 3);
    assert.equal(beforeSnapshot.value.membership?.revision, "rev-1");

    // The owning capability changes the roster (chief leaves) — a NEW send
    // resolves fresh (R8: no cached rosters) and freezes the NEW evidence.
    roster.members = [ALICE, BOB];
    roster.revision = 2;
    const second = unwrap(await alice.sendMessage(sendInput(`thread:${roomId}`, "v2 roster", "rm-4")));
    const afterSnapshot = await cap.store.getSnapshot(second.messageId);
    assert.equal(afterSnapshot.kind, "ok");
    if (afterSnapshot.kind !== "ok") return;
    assert.deepEqual([...afterSnapshot.value.recipients].sort(), [ALICE, BOB].sort());
    assert.equal(afterSnapshot.value.membership?.revision, "rev-2");

    // I5: the FIRST acceptance is untouched — snapshot and Deliveries stand.
    const frozenSnapshot = await cap.store.getSnapshot(first.messageId);
    assert.equal(frozenSnapshot.kind, "ok");
    if (frozenSnapshot.kind === "ok") {
      assert.equal(frozenSnapshot.value.recipients.length, 3, "the frozen recipient set never rewrites");
      assert.equal(frozenSnapshot.value.membership?.revision, "rev-1", "the frozen evidence never rewrites");
    }
    const firstDeliveries = await cap.store.getDeliveries(first.messageId);
    assert.equal(firstDeliveries.kind, "ok");
    if (firstDeliveries.kind === "ok") {
      assert.equal(firstDeliveries.value.length, 3, "the first send keeps its per-member Deliveries");
    }

    // R3 read-time is LIVE membership: the departed chief can no longer read
    // the room — while history they received stays delivered (I10).
    const chief = await sessionFor(cap, "tok-chief");
    const denied = expectError(await chief.getMessages({ threadId: roomId }));
    assert.equal(denied.name, "NotAuthorized");
    await cap.close();
  });
});

describe("S2 rooms — R4 (membership at acceptance; blocked recipients)", () => {
  it("sender not in the room → NotAuthorized (never a silent fan-out)", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const admin = await sessionFor(cap, "tok-admin"); // provisioned, NOT a room member
    const room = await roomThread(alice, "team");

    const denied = expectError(
      await admin.sendMessage(sendInput(`thread:${room.id}`, "intruder", "rm-5")),
    );
    assert.equal(denied.name, "NotAuthorized");

    const history = unwrap(await alice.getMessages({ threadId: room.id }));
    assert.equal(history.messages.length, 0, "nothing was accepted");
    await cap.close();
  });

  it("blocked recipient → terminal failed Delivery for that recipient only; the send is ACCEPTED; inbox never serves it", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    // Chief allows alice; bob blocks everyone (deny-all, no shared direct Thread).
    unwrap(await bob.setContactPolicy({ allowlist: [], defaultRule: "deny" }));
    await allowRoomSender(cap, ALICE, "tok-chief");
    const room = await roomThread(alice, "team");

    const sent = unwrap(
      await alice.sendMessage(sendInput(`thread:${room.id}`, "blocked bob", "rm-6")),
    ); // R4: ACCEPTED — BlockedByContactPolicy is DIRECT-only
    assert.equal(sent.threadId, room.id);

    const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    const byRecipient = new Map(deliveries.deliveries.map((d) => [d.recipientId, d]));
    assert.equal(byRecipient.get(BOB)?.state, "failed", "terminal AT ACCEPTANCE (R4)");
    assert.equal(byRecipient.get(BOB)?.stateReason, "blocked-by-contact-policy");
    assert.equal(byRecipient.get(CHIEF)?.state, "pending", "others unaffected");
    assert.equal(byRecipient.get(ALICE)?.state, "pending");

    // §11.2 + R4: the blocked recipient's inbox never serves the Message.
    const bobInbox = unwrap(await bob.getInbox({}));
    assert.ok(!bobInbox.messages.some((message) => message.id === sent.messageId));
    const chiefInbox = unwrap(await (await sessionFor(cap, "tok-chief")).getInbox({}));
    assert.ok(chiefInbox.messages.some((message) => message.id === sent.messageId));

    // The snapshot records the block honestly (signal, not access control).
    const snapshot = await cap.store.getSnapshot(sent.messageId);
    assert.equal(snapshot.kind, "ok");
    if (snapshot.kind === "ok") {
      assert.deepEqual(snapshot.value.blocked, [
        { personId: BOB, reason: "blocked-by-contact-policy" },
      ]);
      assert.equal(snapshot.value.recipients.length, 3, "the full member set is still frozen");
    }

    // DEC-21: a sweep re-drive is a no-op — the blocked Delivery committed
    // terminal failed inside commitAcceptance (§11.7), so there is nothing
    // for any re-drive to settle, ever.
    const sweep = await cap.runRecoverySweep();
    assert.equal(sweep.failures.length, 0);
    const after = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    assert.equal(
      after.deliveries.find((d) => d.recipientId === BOB)?.state,
      "failed",
      "re-drive never resurrects a blocked Delivery",
    );
    await cap.close();
  });

  it("BlockedByContactPolicy never fires on a room send even when EVERY recipient blocks", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const chief = await sessionFor(cap, "tok-chief");
    unwrap(await bob.setContactPolicy({ allowlist: [], defaultRule: "deny" }));
    unwrap(await chief.setContactPolicy({ allowlist: [], defaultRule: "deny" }));
    const room = await roomThread(alice, "team");

    // Alice's own self-lane is always allowed; bob + chief block her.
    const sent = unwrap(await alice.sendMessage(sendInput(`thread:${room.id}`, "all blocked", "rm-7")));
    const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    const failed = deliveries.deliveries.filter((d) => d.state === "failed");
    assert.equal(failed.length, 2);
    assert.equal(deliveries.deliveries.find((d) => d.recipientId === ALICE)?.state, "pending");
    await cap.close();
  });
});

describe("S2 rooms — R8 linearization (same-resolution sender check)", () => {
  it("exactly ONE resolveMembers per room send; isMember NEVER runs on the send path; revision frozen", async () => {
    const roster = { members: [ALICE, BOB] as PersonId[], revision: 7 };
    const membership = stubMembership("team-capability", "team-1", roster);
    const { cap } = makeHarness({ membership });
    const created = await cap.store.createRoomThread({
      threadKind: "team",
      authority: "team-capability",
      externalId: "team-1",
    });
    assert.equal(created.kind, "ok");
    if (created.kind !== "ok") return;

    const alice = await sessionFor(cap, "tok-alice");
    await allowRoomSender(cap, ALICE, "tok-bob");

    const callsBefore = { resolve: membership.resolveCalls, isMember: membership.isMemberCalls };
    const sent = unwrap(await alice.sendMessage(sendInput(`thread:${created.value.id}`, "r8", "rm-8")));
    assert.equal(
      membership.resolveCalls - callsBefore.resolve,
      1,
      "exactly one fresh resolution inside the accept call (§3.2.1)",
    );
    assert.equal(
      membership.isMemberCalls - callsBefore.isMember,
      0,
      "no second resolution on the send path — the sender check consumed the SAME resolution (§3.2.4)",
    );

    const snapshot = await cap.store.getSnapshot(sent.messageId);
    assert.equal(snapshot.kind, "ok");
    if (snapshot.kind === "ok") {
      assert.equal(snapshot.value.membership?.revision, "rev-7", "the resolution's revision froze with the snapshot");
      assert.equal(snapshot.value.membership?.authority, "team-capability");
    }
    await cap.close();
  });

  it("a sender present in one resolution but absent at send time is rejected from the SAME (fresh) resolution", async () => {
    // Roster WITHOUT the sender: the R4 check is sender ∈ members of THIS
    // resolution — not a cached or separate one.
    const roster = { members: [BOB, CHIEF] as PersonId[], revision: 1 };
    const membership = stubMembership("team-capability", "team-1", roster);
    const { cap } = makeHarness({ membership });
    const created = await cap.store.createRoomThread({
      threadKind: "team",
      authority: "team-capability",
      externalId: "team-1",
    });
    assert.equal(created.kind, "ok");
    if (created.kind !== "ok") return;

    const alice = await sessionFor(cap, "tok-alice");
    const denied = expectError(
      await alice.sendMessage(sendInput(`thread:${created.value.id}`, "not a member", "rm-9")),
    );
    assert.equal(denied.name, "NotAuthorized");
    await cap.close();
  });
});

describe("S2 rooms — R3 authorization (reads, listing, subscriptions)", () => {
  it("GetThread/GetMessages: member reads, non-member is NotAuthorized, unknown room maps UnknownThread, outage maps DependencyUnavailable", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const admin = await sessionFor(cap, "tok-admin");
    await allowRoomSender(cap, ALICE, "tok-bob", "tok-chief");
    const room = await roomThread(alice, "team");
    unwrap(await alice.sendMessage(sendInput(`thread:${room.id}`, "history", "rm-10")));

    // Member reads.
    assert.equal(unwrap(await alice.getThread({ threadId: room.id })).id, room.id);
    assert.equal(unwrap(await alice.getMessages({ threadId: room.id })).messages.length, 1);

    // Non-member: NotAuthorized (exists, not yours — R3).
    assert.equal(expectError(await admin.getThread({ threadId: room.id })).name, "NotAuthorized");
    assert.equal(expectError(await admin.getMessages({ threadId: room.id })).name, "NotAuthorized");

    // A room Thread whose room the authority does NOT know → UnknownThread
    // (§3.3's shared mapping, send AND read). Provisioned directly via §11.4.
    const ghost = await cap.store.createRoomThread({
      threadKind: "team",
      authority: "ghost-authority",
      externalId: "ghost-1",
    });
    assert.equal(ghost.kind, "ok");
    if (ghost.kind !== "ok") return;
    assert.equal(expectError(await alice.getThread({ threadId: ghost.value.id })).name, "UnknownThread");
    assert.equal(
      expectError(await alice.sendMessage(sendInput(`thread:${ghost.value.id}`, "ghost", "rm-11"))).name,
      "UnknownThread",
    );

    // Membership outage: loud, typed, retryable — never a silent allow/deny (G6).
    (cap.membership as ConfigMembership).setUnavailable(true);
    const readOutage = expectError(await alice.getThread({ threadId: room.id }));
    assert.equal(readOutage.name, "DependencyUnavailable");
    assert.equal(readOutage.fields["dependency"], "membership");
    assert.equal(readOutage.retryable, true);
    const sendOutage = expectError(
      await alice.sendMessage(sendInput(`thread:${room.id}`, "during outage", "rm-12")),
    );
    assert.equal(sendOutage.name, "DependencyUnavailable");
    assert.equal(sendOutage.fields["dependency"], "membership");
    (cap.membership as ConfigMembership).setUnavailable(false);

    // Recovery: the same send succeeds after the outage (never a stale roster fallback).
    unwrap(await alice.sendMessage(sendInput(`thread:${room.id}`, "after outage", "rm-12")));
    await cap.close();
  });

  it("ListThreadsForPerson: self-scoped, membership-filtered; policy.admin may list for others", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const admin = await sessionFor(cap, "tok-admin");

    // A direct thread for contrast (bob allowlists alice first).
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "direct", "rm-13")));

    const aliceList = unwrap(await alice.listThreadsForPerson({}));
    assert.equal(aliceList.threads.filter((t) => t.threadKind === "team").length, 1);
    assert.equal(aliceList.threads.filter((t) => t.threadKind === "mission").length, 1);
    assert.equal(aliceList.threads.filter((t) => t.threadKind === "direct").length, 1);

    // The non-member sees NEITHER the rooms NOR others' direct threads.
    const adminList = unwrap(await admin.listThreadsForPerson({}));
    assert.equal(adminList.threads.length, 0);

    // Self only (R3): alice may not list bob's threads.
    assert.equal(
      expectError(await alice.listThreadsForPerson({ personId: BOB })).name,
      "NotAuthorized",
    );
    // policy.admin may list for others — and sees alice's membership-filtered view.
    const adminForAlice = unwrap(await admin.listThreadsForPerson({ personId: ALICE }));
    assert.equal(adminForAlice.threads.length, aliceList.threads.length);

    // Membership outage fails the listing loudly (G6) rather than silently
    // dropping rooms.
    (cap.membership as ConfigMembership).setUnavailable(true);
    assert.equal(expectError(await alice.listThreadsForPerson({})).name, "DependencyUnavailable");
    (cap.membership as ConfigMembership).setUnavailable(false);
    await cap.close();
  });

  it("Subscribe: explicit room scope for a non-member fails loudly; members receive room facts; non-members are filtered", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const admin = await sessionFor(cap, "tok-admin");
    await allowRoomSender(cap, ALICE, "tok-bob", "tok-chief");
    const room = await roomThread(alice, "team");

    // Explicit scope: non-member → the WHOLE Subscribe fails (G6, never silent).
    const denied = expectError(
      await admin.subscribe({ events: ["MessageCommitted"], threads: [room.id] }, collectSink().sink),
    );
    assert.equal(denied.name, "NotAuthorized");
    // Member explicit scope → the stream opens.
    const memberScoped = collectSink();
    unwrap(await alice.subscribe({ events: ["MessageCommitted"], threads: [room.id] }, memberScoped.sink));

    // Unscoped: a member and a non-member.
    const member = collectSink();
    const nonMember = collectSink();
    unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, member.sink));
    unwrap(await admin.subscribe({ events: ["MessageCommitted"] }, nonMember.sink));

    const sent = unwrap(await alice.sendMessage(sendInput(`thread:${room.id}`, "room fact", "rm-14")));
    await cap.pumpEvents();
    await flushMicrotasks();

    const memberEvents = member.frames.filter((frame) => frame.kind === "event");
    assert.ok(
      memberEvents.some((frame) => {
        const event = frame.event as { message?: { id: string } };
        return event.message?.id === sent.messageId;
      }),
      "the member is PUSHED the room MessageCommitted (L10 starvation is gone)",
    );
    const scopedEvents = memberScoped.frames.filter((frame) => frame.kind === "event");
    assert.equal(scopedEvents.length, 1, "explicit member scope confines to the room");
    const nonMemberEvents = nonMember.frames.filter((frame) => frame.kind === "event");
    assert.equal(nonMemberEvents.length, 0, "the non-member's unscoped stream filters the room fact (no leak)");
    await cap.close();
  });
});

describe("S2 rooms — R5 attention on rooms (DND hold/release, MSG-010)", () => {
  it("per-recipient DND holds; urgent without the grant downgrades once for the send; release resumes", async () => {
    const { cap } = await makeRoomHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowRoomSender(cap, ALICE, "tok-bob", "tok-chief");
    unwrap(await bob.setDndPolicy({ enabled: true }));
    const room = await roomThread(alice, "team");

    // Alice is a Worker — no priority.override grant (DEFAULT_ROLE_GRANTS).
    const sent = unwrap(
      await alice.sendMessage(sendInput(`thread:${room.id}`, "urgent room", "rm-15", "urgent")),
    );
    assert.equal(sent.urgentDowngraded, true, "typed downgrade, never silent (MSG-010 on rooms)");

    const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    const byRecipient = new Map(deliveries.deliveries.map((d) => [d.recipientId, d]));
    assert.equal(byRecipient.get(BOB)?.state, "held", "DND recipient held (R5 dnd-hold)");
    assert.equal(byRecipient.get(BOB)?.stateReason, "dnd-hold");
    assert.equal(byRecipient.get(CHIEF)?.state, "pending", "non-DND recipients unaffected");
    assert.equal(byRecipient.get(ALICE)?.state, "pending");

    // Release: held → pending (dnd-released), attempts resume (no presence → pending).
    unwrap(await bob.setDndPolicy({ enabled: false }));
    const released = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    assert.equal(released.deliveries.find((d) => d.recipientId === BOB)?.state, "pending");
    await cap.close();
  });
});

describe("S2 rooms — F1: R4 holds INSIDE the commit→settle window (terminal AT COMMIT, §11.7)", () => {
  /**
   * The auditor's two ordinary interleavings (no crash needed) against a
   * blocked recipient. The F4 fault-injection knob (effectLegDelayMs) holds
   * the commit→settle window open deterministically; the test parks inside it
   * after the durable commit. Post-fix the blocked Delivery is terminal
   * failed{blocked-by-contact-policy} from the instant commitAcceptance
   * returns, so NEITHER interleaving can ever deliver it — pre-fix both
   * interleavings DID deliver it (the blocked set lived only on the snapshot
   * and no re-drive path consulted it).
   */
  it("path A: blocked recipient opens presence inside the window → NEVER delivered, terminal from commit, inbox clean", async () => {
    const { cap, transport } = makeHarness({ membership: { rooms: [TEAM] }, effectLegDelayMs: 250 });
    await cap.start();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [], defaultRule: "deny" })); // bob blocks alice
    await allowRoomSender(cap, ALICE, "tok-chief");
    const room = await roomThread(alice, "team");

    const sendPromise = alice.sendMessage(sendInput(`thread:${room.id}`, "window A", "f1-a"));
    const messageId = await waitForCommit(cap, "f1-a"); // inside the commit→settle window

    // The window no longer exists for R4: terminal failed from the instant
    // commitAcceptance returned — never pending, never in the inbox.
    const midWindow = await cap.store.getDeliveries(messageId);
    assert.equal(midWindow.kind, "ok");
    if (midWindow.kind === "ok") {
      const bobDelivery = midWindow.value.find((delivery) => delivery.recipientId === BOB);
      assert.equal(bobDelivery?.state, "failed", "terminal AT COMMIT — inside the old window");
      assert.equal(bobDelivery?.stateReason, "blocked-by-contact-policy");
    }
    const bobInboxMid = unwrap(await bob.getInbox({}));
    assert.ok(
      !bobInboxMid.messages.some((message) => message.id === messageId),
      "the blocked recipient's inbox never contains the message — even inside the old window",
    );

    // Path A: the blocked recipient opens presence BEFORE the effect leg runs.
    const bobPresence = unwrap(await bob.openPresence({ transport: "ws" }));
    await flushMicrotasks();

    const sent = unwrap(await sendPromise);
    assert.equal(sent.messageId, messageId);
    const deliveries = unwrap(await alice.getDelivery({ messageId }));
    const bobDelivery = deliveries.deliveries.find((delivery) => delivery.recipientId === BOB);
    assert.equal(bobDelivery?.state, "failed", "the presence-open re-drive NEVER delivers a blocked recipient");
    assert.equal(bobDelivery?.stateReason, "blocked-by-contact-policy");
    assert.ok(
      !transport.effects.some((effect) => effect.presenceId === bobPresence.presenceId),
      "no transport effect ever reached the blocked recipient",
    );
    // The deliverable recipients were unaffected (chief pending — no presence).
    assert.equal(deliveries.deliveries.find((d) => d.recipientId === CHIEF)?.state, "pending");
    await cap.close();
  });

  it("path B: DND-hold inside the window + DND release after settle → NEVER delivered, terminal from commit", async () => {
    const { cap, transport } = makeHarness({ membership: { rooms: [TEAM] }, effectLegDelayMs: 250 });
    await cap.start();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [], defaultRule: "deny" })); // bob blocks alice
    unwrap(await bob.setDndPolicy({ enabled: true })); // AND bob is DND
    await allowRoomSender(cap, ALICE, "tok-chief");
    const room = await roomThread(alice, "team");

    const sendPromise = alice.sendMessage(sendInput(`thread:${room.id}`, "window B", "f1-b"));
    const messageId = await waitForCommit(cap, "f1-b");

    // Terminal from commit — a DND re-trigger cannot even hold it.
    const midWindow = await cap.store.getDeliveries(messageId);
    assert.equal(midWindow.kind, "ok");
    if (midWindow.kind === "ok") {
      const bobDelivery = midWindow.value.find((delivery) => delivery.recipientId === BOB);
      assert.equal(bobDelivery?.state, "failed", "terminal AT COMMIT — not holdable");
      assert.equal(bobDelivery?.stateReason, "blocked-by-contact-policy");
    }

    // Inside the window: the presence-open re-trigger fires (pre-fix this
    // HELD the blocked Delivery; the effect-leg blocked CAS then lost with a
    // swallowed StateConflict and effects were marked settled).
    const bobPresence = unwrap(await bob.openPresence({ transport: "ws" }));
    await flushMicrotasks();
    const sent = unwrap(await sendPromise);
    assert.equal(sent.messageId, messageId);

    // After settle: DND release must NOT resurrect the blocked Delivery
    // (pre-fix: held → pending → delivered to the blocked recipient).
    unwrap(await bob.setDndPolicy({ enabled: false }));
    await flushMicrotasks();

    const deliveries = unwrap(await alice.getDelivery({ messageId }));
    const bobDelivery = deliveries.deliveries.find((delivery) => delivery.recipientId === BOB);
    assert.equal(bobDelivery?.state, "failed", "DND release NEVER resurrects a blocked recipient");
    assert.equal(bobDelivery?.stateReason, "blocked-by-contact-policy");
    assert.ok(
      !transport.effects.some((effect) => effect.presenceId === bobPresence.presenceId),
      "no transport effect ever reached the blocked recipient",
    );
    const bobInbox = unwrap(await bob.getInbox({}));
    assert.ok(!bobInbox.messages.some((message) => message.id === messageId));
    await cap.close();
  });
});

describe("S2 rooms — F3: the DEC-21 sweep recovers a TORN room acceptance with blocked recipients", () => {
  it("crash before settle: the blocked recipient is terminal FROM THE COMMIT, the sweep drives the rest, report consistent", async () => {
    // Fault-injected window (the F4 knob): the commit→settle window is held
    // open, so the acceptance sits effectsPending = true — a genuine torn
    // acceptance exactly as a crash inside the window leaves one. The sweep
    // runs INSIDE the window and is what actually drives the deliverable
    // recipient's effect and the settle.
    const { cap, transport } = makeHarness({
      membership: { rooms: [TEAM] },
      effectLegDelayMs: 250,
    });
    await cap.start();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const chief = await sessionFor(cap, "tok-chief");
    unwrap(await bob.setContactPolicy({ allowlist: [], defaultRule: "deny" })); // bob blocks alice
    await allowRoomSender(cap, ALICE, "tok-chief");
    const bobPresence = unwrap(await bob.openPresence({ transport: "ws" })); // live lane — a re-drive COULD deliver bob if R4 leaked
    const chiefPresence = unwrap(await chief.openPresence({ transport: "ws" }));
    const room = await roomThread(alice, "team");

    const sendPromise = alice.sendMessage(sendInput(`thread:${room.id}`, "torn", "f3-torn"));
    const messageId = await waitForCommit(cap, "f3-torn"); // parked inside the window

    // The blocked recipient was terminal FROM THE COMMIT — before any sweep,
    // before any effect leg (§11.7).
    const atCommit = await cap.store.getDeliveries(messageId);
    assert.equal(atCommit.kind, "ok");
    if (atCommit.kind === "ok") {
      const bobDelivery = atCommit.value.find((delivery) => delivery.recipientId === BOB);
      assert.equal(bobDelivery?.state, "failed");
      assert.equal(bobDelivery?.stateReason, "blocked-by-contact-policy");
      assert.equal(
        atCommit.value.find((delivery) => delivery.recipientId === CHIEF)?.state,
        "pending",
        "the deliverable recipient is genuinely un-driven — the sweep must do the work",
      );
    }

    // THE recovery path: the sweep re-drives the torn acceptance (the
    // pipeline's own effect leg is still parked by the fault injection).
    const report = await cap.runRecoverySweep();
    assert.equal(report.found, 1, "the torn acceptance was found");
    assert.equal(report.settled, 1, "the sweep settled it");
    assert.deepEqual(report.failures, [], "sweep report consistency: no failures");

    // The sweep drove the deliverable recipient to a REAL effect; the blocked
    // recipient stayed terminal and was never attempted.
    const swept = unwrap(await alice.getDelivery({ messageId }));
    assert.equal(swept.deliveries.find((d) => d.recipientId === CHIEF)?.state, "delivered");
    assert.equal(swept.deliveries.find((d) => d.recipientId === BOB)?.state, "failed");
    assert.ok(
      transport.effects.some((effect) => effect.presenceId === chiefPresence.presenceId),
      "the sweep produced the chief's real adapter effect (DEC-08)",
    );
    assert.ok(
      !transport.effects.some((effect) => effect.presenceId === bobPresence.presenceId),
      "the blocked recipient was never attempted despite a live lane (§11.7)",
    );
    const bobInbox = unwrap(await bob.getInbox({}));
    assert.ok(!bobInbox.messages.some((message) => message.id === messageId));

    // The parked pipeline leg wakes to an already-recovered acceptance:
    // everything idempotent — no double effect, the send resolves accepted.
    const sent = unwrap(await sendPromise);
    assert.equal(sent.messageId, messageId);
    assert.equal(
      transport.effects.filter((effect) => effect.payload.message.id === messageId).length,
      1,
      "no double delivery when the pipeline leg caught up",
    );
    const pendingAfter = await cap.store.listPendingAcceptances();
    assert.equal(pendingAfter.kind, "ok");
    if (pendingAfter.kind === "ok") assert.equal(pendingAfter.value.acceptances.length, 0);
    await cap.close();
  });
});

describe("S2 rooms — F5/F8/F9 seam-edge regressions", () => {
  it("F5: a membership adapter repeating a member → snapshot recipients deduped (first occurrence wins), one Delivery each", async () => {
    // The contract freezes uniqueItems on recipients; the core owns the
    // record, so decideSend dedupes even when the seam hands it duplicates.
    const roster = { members: [ALICE, BOB, BOB, ALICE] as PersonId[], revision: 1 };
    const membership = stubMembership("team-capability", "team-1", roster);
    const { cap } = makeHarness({ membership });
    const created = await cap.store.createRoomThread({
      threadKind: "team",
      authority: "team-capability",
      externalId: "team-1",
    });
    assert.equal(created.kind, "ok");
    if (created.kind !== "ok") return;

    const alice = await sessionFor(cap, "tok-alice");
    await allowRoomSender(cap, ALICE, "tok-bob");
    const sent = unwrap(await alice.sendMessage(sendInput(`thread:${created.value.id}`, "dupes", "f5-dupes")));

    const snapshot = await cap.store.getSnapshot(sent.messageId);
    assert.equal(snapshot.kind, "ok");
    if (snapshot.kind === "ok") {
      assert.deepEqual(snapshot.value.recipients, [ALICE, BOB], "unique, first occurrence wins");
    }
    const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    assert.equal(deliveries.deliveries.length, 2, "one Delivery per UNIQUE recipient");
    await cap.close();
  });

  it("F8a: the §3.3 deadline is enforced — a hung membership authority fails the send DependencyUnavailable, never hangs", async () => {
    const hanging: MembershipSource = {
      resolveMembers: () => new Promise<ResolveMembersOutcome>(() => {}), // never settles
      isMember: () => new Promise<IsMemberOutcome>(() => {}),
    };
    const { cap } = makeHarness({ membership: hanging, membershipDeadlineMs: 50 });
    const created = await cap.store.createRoomThread({
      threadKind: "team",
      authority: "team-capability",
      externalId: "team-hang",
    });
    assert.equal(created.kind, "ok");
    if (created.kind !== "ok") return;

    const alice = await sessionFor(cap, "tok-alice");
    const started = Date.now();
    const error = expectError(
      await alice.sendMessage(sendInput(`thread:${created.value.id}`, "during hang", "f8-deadline")),
    );
    assert.ok(Date.now() - started < 5_000, "the caller was bounded, not hung");
    assert.equal(error.name, "DependencyUnavailable");
    assert.equal(error.fields["dependency"], "membership");
    assert.equal(error.retryable, true);
    await cap.close();
  });

  it("F8c: control characters in room authority/externalId are rejected fail-fast at adapter construction", async () => {
    const clock = createSeededClock({ seed: "rooms-f8c" });
    for (const bad of [
      { threadKind: "team" as const, authority: "team-\ncapability", externalId: "team-1", members: [ALICE] },
      { threadKind: "team" as const, authority: "team-capability", externalId: "team\t1", members: [ALICE] },
    ]) {
      assert.throws(
        () => createConfigMembership({ rooms: [bad] }, clock),
        (error: unknown) =>
          error instanceof Error && error.name === "DependencyUnavailable",
        `control characters in ${JSON.stringify(bad)} never become an adapter (room-key collision)`,
      );
    }
    // ...while a colliding-looking but clean pair stays distinct.
    const clean = createConfigMembership(
      {
        rooms: [
          { threadKind: "team", authority: "ab", externalId: "c", members: [ALICE] },
          { threadKind: "team", authority: "a", externalId: "bc", members: [BOB] },
        ],
      },
      clock,
    );
    const first = await clean.resolveMembers({ authority: "ab", externalId: "c" });
    assert.equal(first.kind, "resolved");
    if (first.kind === "resolved") assert.deepEqual(first.members, [ALICE]);
  });

  it("F9: membership revocation mid-subscription — room facts stop flowing (live push AND cursor replay re-check)", async () => {
    const roster = { members: [ALICE, BOB] as PersonId[], revision: 1 };
    const membership = stubMembership("team-capability", "team-1", roster);
    const { cap } = makeHarness({ membership });
    const created = await cap.store.createRoomThread({
      threadKind: "team",
      authority: "team-capability",
      externalId: "team-1",
    });
    assert.equal(created.kind, "ok");
    if (created.kind !== "ok") return;
    const roomId = created.value.id;

    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    await allowRoomSender(cap, ALICE, "tok-bob");

    const bobStream = collectSink();
    unwrap(await bob.subscribe({ events: ["MessageCommitted"] }, bobStream.sink));

    // Member: bob is pushed the room fact.
    const first = unwrap(await alice.sendMessage(sendInput(`thread:${roomId}`, "while member", "f9-m1")));
    await cap.pumpEvents();
    await flushMicrotasks();
    assert.equal(
      bobStream.frames.filter((frame) => frame.kind === "event").length,
      1,
      "the member receives room facts",
    );

    // The owning capability REVOKES bob.
    roster.members = [ALICE];
    roster.revision = 2;

    const second = unwrap(await alice.sendMessage(sendInput(`thread:${roomId}`, "after revoke", "f9-m2")));
    await cap.pumpEvents();
    await flushMicrotasks();
    assert.equal(
      bobStream.frames.filter((frame) => frame.kind === "event").length,
      1,
      "the revoked member is NOT pushed subsequent room facts (live isMember re-check, R3)",
    );

    // The replay path re-checks too: a fresh subscription with a cursor
    // BEFORE both sends replays NEITHER room fact to the revoked member.
    const replay = collectSink();
    unwrap(
      await bob.subscribe(
        { events: ["MessageCommitted"], since: "s_0" as Cursor },
        replay.sink,
      ),
    );
    const replayed = replay.frames.filter((frame) => frame.kind === "event");
    assert.equal(replayed.length, 0, "cursor replay re-checks CURRENT membership — no leak via replay");
    assert.ok(first.messageId !== second.messageId);
    await cap.close();
  });
});

// --- test doubles ---------------------------------------------------------------

/**
 * A mutable-roster MembershipSource (stands in for the owning Team/Mission
 * capability): fresh resolution per call, call-counted so the R8
 * single-resolution ruling is assertable, revision = "rev-<n>" evidence.
 */
function stubMembership(
  authority: string,
  externalId: string,
  roster: { members: PersonId[]; revision: number },
): MembershipSource & { resolveCalls: number; isMemberCalls: number } {
  const key = `${authority}\n${externalId}`;
  const stub = {
    resolveCalls: 0,
    isMemberCalls: 0,
    async resolveMembers(room: RoomRef): Promise<ResolveMembersOutcome> {
      stub.resolveCalls += 1;
      if (`${room.authority}\n${room.externalId}` !== key) {
        return { kind: "unknown", error: unknownRoom(room) };
      }
      const evidence: MembershipEvidence = {
        authority,
        revision: `rev-${roster.revision}`,
        resolvedAt: new Date(0).toISOString() as Timestamp,
      };
      return { kind: "resolved", members: [...roster.members], evidence };
    },
    async isMember(room: RoomRef, personId: PersonId): Promise<IsMemberOutcome> {
      stub.isMemberCalls += 1;
      if (`${room.authority}\n${room.externalId}` !== key) {
        return { kind: "unknown", error: unknownRoom(room) };
      }
      return { kind: "known", member: roster.members.includes(personId) };
    },
  };
  return stub;
}
