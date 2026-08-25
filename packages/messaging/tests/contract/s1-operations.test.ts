/**
 * S1 through-the-door operations suite — the formal contract proof for the
 * full S1 public surface via the embedded composition root. Every command,
 * every S1 query, and the Subscribe stream: happy path + validation
 * rejections (malformed/unknown fields → typed ValidationFailed, NEVER a
 * throw) + I3-envelope conformance on returned records + error names exactly
 * from the 13-error catalogue.
 *
 * Deep behaviour (idempotency races, DND state machine, delivery retry,
 * subscription replay/overflow/teardown, WS round-trips) is proven by the
 * S1-b/c suites under tests/core, tests/protocol, and tests/standalone —
 * referenced, not duplicated. This suite's job is completeness of the
 * SURFACE: every operation crossed once in each direction of honesty.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  constants,
  createEmbeddedMessaging,
  DEFAULT_ROLE_GRANTS,
  errorCatalogue,
  MessagingError,
  schemaVersion,
} from "../../contract/index.js";
import type {
  ErrorName,
  Outcome,
  SubscriptionMessage,
  SubscriptionSink,
} from "../../contract/index.js";
import {
  ALICE,
  BOB,
  STRANGER,
  expectError,
  flushMicrotasks,
  makeHarness,
  sendInput,
  sessionFor,
  unwrap,
} from "../core/helpers.js";

const CATALOGUE: readonly string[] = errorCatalogue.map((entry) => entry.name);

/** Typed outcome, name in the 13-error catalogue, honest shape — never a leaked exception. */
function expectCatalogueError<T>(outcome: Outcome<T>, name: ErrorName): MessagingError {
  const error = expectError(outcome);
  assert.ok(error instanceof MessagingError, "errors are the public MessagingError type");
  assert.equal(error.name, name);
  assert.ok(CATALOGUE.includes(error.name), `${error.name} is in the 13-error catalogue`);
  assert.equal(typeof error.message, "string");
  assert.ok(error.message.length > 0, "errors are actionable (a message, never a bare name)");
  assert.equal(typeof error.retryable, "boolean");
  assert.equal(typeof error.fields, "object");
  return error;
}

/** I3: every independently persisted object carries id · kind · schemaVersion · createdAt. */
function assertI3(record: Record<string, unknown>, idPrefix: string, kind: string, label: string): void {
  assert.equal(typeof record["id"], "string", `${label}: has an id`);
  assert.ok((record["id"] as string).startsWith(idPrefix), `${label}: id is branded ${idPrefix}…`);
  assert.equal(record["kind"], kind, `${label}: kind`);
  assert.equal(record["schemaVersion"], schemaVersion, `${label}: schemaVersion`);
  assert.equal(typeof record["createdAt"], "string", `${label}: createdAt`);
  assert.ok(!Number.isNaN(Date.parse(record["createdAt"] as string)), `${label}: createdAt is a timestamp`);
}

describe("door discipline (MSG-021): malformed input is a typed ValidationFailed, never a throw", () => {
  it("every door operation rejects non-object and malformed input without throwing", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const sink: SubscriptionSink = async () => ({ kind: "effect" });

    const doors: [string, (input: unknown) => Promise<Outcome<unknown>>][] = [
      ["sendMessage", (input) => alice.sendMessage(input)],
      ["openPresence", (input) => alice.openPresence(input)],
      ["closePresence", (input) => alice.closePresence(input)],
      ["setDndPolicy", (input) => alice.setDndPolicy(input)],
      ["setContactPolicy", (input) => alice.setContactPolicy(input)],
      ["getThread", (input) => alice.getThread(input)],
      ["getMessages", (input) => alice.getMessages(input)],
      ["getInbox", (input) => alice.getInbox(input)],
      ["getDelivery", (input) => alice.getDelivery(input)],
      ["getPolicy", (input) => alice.getPolicy(input)],
      ["getPresence", (input) => alice.getPresence(input)],
      ["subscribe", (input) => alice.subscribe(input, sink)],
    ];

    for (const [name, door] of doors) {
      for (const garbage of [null, 42, "text", []]) {
        const outcome = await door(garbage);
        expectCatalogueError(outcome, "ValidationFailed");
      }
      void name;
    }

    // `{}` is a VALID input for the two self-defaulting queries (personId is
    // optional — the caller's own inbox/policy); every other door rejects it.
    for (const [name, door] of doors) {
      const empty = await door({});
      if (name === "getInbox" || name === "getPolicy") {
        assert.equal(empty.kind, "ok", `${name}({}) defaults to self`);
      } else {
        expectCatalogueError(empty, "ValidationFailed");
      }
    }
    await cap.close();
  });
});

describe("SendMessage (command)", () => {
  it("happy path: SendAccepted with branded IDs and journal sequence", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "hello", "c-1")));
    assert.ok(accepted.messageId.startsWith("message_"));
    assert.ok(accepted.threadId.startsWith("thread_"));
    assert.equal(typeof accepted.sequence, "number");
    assert.equal(accepted.duplicate, undefined, "first acceptance is not marked duplicate");
    await cap.close();
  });

  it("validation: unknown fields (incl. a spoofed sender) and bad values are typed rejections", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    // Allowlisted so every case below fails at the door / decision point under
    // test — never earlier at the contact-policy gate.
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    // MSG-020/G3: a caller-supplied `from` fails the schema — identity comes
    // from authentication, never the payload.
    const spoof = await alice.sendMessage({
      ...sendInput(`person:${BOB}`, "spoof", "c-spoof"),
      from: BOB,
    });
    expectCatalogueError(spoof, "ValidationFailed");

    const badPriority = await alice.sendMessage({
      address: `person:${BOB}`,
      body: { text: "x" },
      priority: "critical",
      clientMessageId: "c-badpriority",
    });
    expectCatalogueError(badPriority, "ValidationFailed");

    // O6/R13: the contract constant is enforced at the door.
    const oversized = await alice.sendMessage({
      address: `person:${BOB}`,
      body: { text: "x".repeat(constants.messageMaxBytes) },
      priority: "normal",
      clientMessageId: "c-big",
    });
    expectCatalogueError(oversized, "ValidationFailed");

    const badAddress = await alice.sendMessage({
      address: "email:bob@example.com",
      body: { text: "x" },
      priority: "normal",
      clientMessageId: "c-badaddr",
    });
    expectCatalogueError(badAddress, "ValidationFailed");
    await cap.close();
  });

  it("typed refusals: UnknownRecipient (MSG-014) and BlockedByContactPolicy (DEC-14)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    const stranger = await alice.sendMessage(sendInput(`person:${STRANGER}`, "anyone?", "c-stranger"));
    expectCatalogueError(stranger, "UnknownRecipient");

    // Bob has no allowlist entry for Alice — default-deny (DEC-14).
    const blocked = await alice.sendMessage(sendInput(`person:${BOB}`, "unsolicited", "c-blocked"));
    const error = expectCatalogueError(blocked, "BlockedByContactPolicy");
    assert.equal(error.fields["recipientId"], BOB);
    await cap.close();
  });

  it("idempotency (DEC-13, A5): retry returns the original; different content conflicts", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    const first = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "once", "c-idem")));
    const retry = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "once", "c-idem")));
    assert.equal(retry.duplicate, true);
    assert.equal(retry.messageId, first.messageId);
    assert.equal(retry.sequence, first.sequence);

    const conflict = await alice.sendMessage(sendInput(`person:${BOB}`, "DIFFERENT", "c-idem"));
    const error = expectCatalogueError(conflict, "IdempotencyConflict");
    assert.equal(error.fields["originalMessageId"], first.messageId);
    await cap.close();
  });
});

describe("OpenPresence / ClosePresence (commands)", () => {
  it("happy path: open mints a Presence (I3 via GetPresence); close removes it; close is idempotent (R9)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    const opened = unwrap(await alice.openPresence({ transport: "ws", clientLabel: "contract-test" }));
    assert.ok(opened.presenceId.startsWith("presence_"));

    const listed = unwrap(await alice.getPresence({ personId: ALICE }));
    assert.equal(listed.presences.length, 1);
    assertI3(listed.presences[0] as never, "presence_", "presence", "Presence");

    unwrap(await alice.closePresence({ presenceId: opened.presenceId }));
    const after = unwrap(await alice.getPresence({ personId: ALICE }));
    assert.equal(after.presences.length, 0);

    // R9: closing an unknown/already-closed Presence succeeds (idempotent).
    unwrap(await alice.closePresence({ presenceId: opened.presenceId }));
    await cap.close();
  });

  it("validation: missing transport, unknown transport kind, unknown fields, malformed presence id", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    expectCatalogueError(await alice.openPresence({ clientLabel: "x" }), "ValidationFailed");
    expectCatalogueError(
      await alice.openPresence({ transport: "carrier-pigeon" }),
      "ValidationFailed",
    );
    expectCatalogueError(
      await alice.openPresence({ transport: "ws", unexpected: true }),
      "ValidationFailed",
    );
    expectCatalogueError(await alice.closePresence({ presenceId: "not-a-presence" }), "ValidationFailed");
    await cap.close();
  });

  it("ownership: closing another Person's Presence is NotAuthorized", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const bobs = unwrap(await bob.openPresence({ transport: "ws" }));

    const stolen = await alice.closePresence({ presenceId: bobs.presenceId });
    expectCatalogueError(stolen, "NotAuthorized");
    await cap.close();
  });
});

describe("SetDndPolicy / SetContactPolicy (commands)", () => {
  it("happy path: PolicyUpdated; GetPolicy reflects the change on I3 records", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    unwrap(await alice.setDndPolicy({ enabled: true }));
    unwrap(await alice.setContactPolicy({ allowlist: [BOB], defaultRule: "deny" }));

    const view = unwrap(await alice.getPolicy({}));
    assertI3(view.contact as never, "contactpolicy_", "contact-policy", "ContactPolicy");
    assertI3(view.dnd as never, "dndpolicy_", "dnd-policy", "DndPolicy");
    assert.deepEqual(view.contact.allowlist, [BOB]);
    assert.equal(view.contact.defaultRule, "deny");
    assert.equal(view.dnd.enabled, true);
    await cap.close();
  });

  it("validation: bad value types and unknown enum values", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    expectCatalogueError(await alice.setDndPolicy({ enabled: "yes" }), "ValidationFailed");
    expectCatalogueError(
      await alice.setContactPolicy({ allowlist: [], defaultRule: "maybe" }),
      "ValidationFailed",
    );
    expectCatalogueError(
      await alice.setContactPolicy({ allowlist: ["not-a-person"], defaultRule: "deny" }),
      "ValidationFailed",
    );
    expectCatalogueError(
      await alice.setContactPolicy({ allowlist: [], defaultRule: "deny", extra: 1 }),
      "ValidationFailed",
    );
    await cap.close();
  });

  it("authorization: policy.admin may set another Person's policy; others may not", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const admin = await sessionFor(cap, "tok-admin");

    const denied = await alice.setDndPolicy({ personId: BOB, enabled: true });
    expectCatalogueError(denied, "NotAuthorized");

    unwrap(await admin.setDndPolicy({ personId: BOB, enabled: true }));
    const bobs = await sessionFor(cap, "tok-bob");
    const view = unwrap(await bobs.getPolicy({}));
    assert.equal(view.dnd.enabled, true, "admin-set policy took effect");
    await cap.close();
  });
});

describe("queries: GetThread / GetMessages / GetInbox / GetDelivery / GetPolicy / GetPresence", () => {
  async function conversation(cap: ReturnType<typeof makeHarness>["cap"]) {
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    const first = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "one", "q-1")));
    const second = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "two", "q-2")));
    return { alice, bob, first, second };
  }

  it("GetThread: the Thread record (I3) — or UnknownThread; validation at the door", async () => {
    const { cap } = makeHarness();
    const { alice, first } = await conversation(cap);

    const thread = unwrap(await alice.getThread({ threadId: first.threadId }));
    assertI3(thread as never, "thread_", "thread", "Thread");
    assert.equal(thread.id, first.threadId);

    expectCatalogueError(await alice.getThread({}), "ValidationFailed");
    expectCatalogueError(await alice.getThread({ threadId: "thread_nope" }), "UnknownThread");
    await cap.close();
  });

  it("GetMessages: ordered history (DEC-19) of I3 Messages; limit clamped, never rejected; bad cursor typed", async () => {
    const { cap } = makeHarness();
    const { alice, bob, first } = await conversation(cap);

    const page = unwrap(await alice.getMessages({ threadId: first.threadId }));
    assert.deepEqual(
      page.messages.map((message) => message.body.text),
      ["one", "two"],
    );
    for (const message of page.messages) {
      assertI3(message as never, "message_", "message", "Message");
      assert.equal(message.senderId, ALICE, "I4: sender identity from authentication");
    }
    assert.ok(
      (page.messages[0]?.sequence as number) < (page.messages[1]?.sequence as number),
      "sequence-ordered",
    );

    // Store-Seam §4: limit is clamped to pageLimitMax, never rejected.
    const clamped = unwrap(await alice.getMessages({ threadId: first.threadId, limit: 999_999 }));
    assert.equal(clamped.messages.length, 2);

    expectCatalogueError(await alice.getMessages({}), "ValidationFailed");
    expectCatalogueError(
      await alice.getMessages({ threadId: first.threadId, cursor: "bogus" }),
      "ValidationFailed",
    );
    expectCatalogueError(await alice.getMessages({ threadId: "thread_nope" }), "UnknownThread");

    // The recipient reads the same history (G9: one copy).
    const bobsPage = unwrap(await bob.getMessages({ threadId: first.threadId }));
    assert.deepEqual(
      bobsPage.messages.map((message) => message.id),
      page.messages.map((message) => message.id),
    );
    await cap.close();
  });

  it("GetInbox: the offline recipient pulls held/pending Messages (guarantee 6); validation at the door", async () => {
    const { cap } = makeHarness();
    const { bob } = await conversation(cap);

    const inbox = unwrap(await bob.getInbox({}));
    assert.deepEqual(
      inbox.messages.map((message) => message.body.text),
      ["one", "two"],
      "offline messages await the recipient — nothing erased",
    );
    for (const message of inbox.messages) {
      assertI3(message as never, "message_", "message", "inbox Message");
    }

    expectCatalogueError(await bob.getInbox({ cursor: "not-a-cursor" }), "ValidationFailed");
    await cap.close();
  });

  it("GetDelivery: per-recipient Delivery records (I3); UnknownMessage; validation at the door", async () => {
    const { cap } = makeHarness();
    const { alice, first } = await conversation(cap);

    const result = unwrap(await alice.getDelivery({ messageId: first.messageId }));
    assert.equal(result.deliveries.length, 1, "direct send: exactly one Delivery (DEC-05 shape)");
    const delivery = result.deliveries[0];
    assertI3(delivery as never, "delivery_", "delivery", "Delivery");
    assert.equal(delivery?.recipientId, BOB);
    assert.equal(delivery?.state, "pending", "no-presence rule: pending, never failed (R5)");

    expectCatalogueError(await alice.getDelivery({}), "ValidationFailed");
    expectCatalogueError(await alice.getDelivery({ messageId: "message_nope" }), "UnknownMessage");
    await cap.close();
  });

  it("GetPolicy: self read; another Person's policy needs policy.admin", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    const own = unwrap(await alice.getPolicy({}));
    assertI3(own.contact as never, "contactpolicy_", "contact-policy", "default ContactPolicy");
    assert.equal(own.contact.defaultRule, "deny", "DEC-14 default rule");

    const denied = await alice.getPolicy({ personId: BOB });
    expectCatalogueError(denied, "NotAuthorized");

    expectCatalogueError(await alice.getPolicy({ personId: "not-a-person" }), "ValidationFailed");
    await cap.close();
  });

  it("GetPresence: validation at the door (personId required, branded)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");

    expectCatalogueError(await alice.getPresence({}), "ValidationFailed");
    expectCatalogueError(await alice.getPresence({ personId: "nope" }), "ValidationFailed");
    const empty = unwrap(await alice.getPresence({ personId: BOB }));
    assert.deepEqual(empty.presences, []);
    await cap.close();
  });
});

describe("Subscribe (stream op, R1)", () => {
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

  it("happy path: started → pushed MessageCommitted after the journal tail → ended on close (MSG-023)", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    const { sink, frames } = collectSink();
    const handle = unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));
    assert.ok(handle.subscriptionId.startsWith("subscription_"));

    const started = frames.find((frame) => frame.kind === "started");
    assert.ok(started !== undefined, "the stream acknowledges with started");
    assert.equal(started?.subscriptionId, handle.subscriptionId);

    const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "pushed", "s-1")));
    await cap.pumpEvents();
    await flushMicrotasks();

    const event = frames.find((frame) => frame.kind === "event");
    assert.ok(event !== undefined, "the event is PUSHED to the sink — never polled");
    assert.equal(event?.subscriptionId, handle.subscriptionId);
    assert.equal(
      ((event?.event as { message?: { id: string } }).message?.id),
      accepted.messageId,
    );

    await handle.close();
    await flushMicrotasks();
    const ended = frames.find((frame) => frame.kind === "ended");
    assert.ok(ended !== undefined, "client close ends the stream");
    assert.equal(ended?.subscriptionId, handle.subscriptionId);
    await cap.close();
  });

  it("validation: empty/duplicate/unknown event kinds and unknown fields", async () => {
    const { cap } = makeHarness();
    const alice = await sessionFor(cap, "tok-alice");
    const { sink } = collectSink();

    expectCatalogueError(await alice.subscribe({ events: [] }, sink), "ValidationFailed");
    expectCatalogueError(
      await alice.subscribe({ events: ["Teleport"] }, sink),
      "ValidationFailed",
    );
    expectCatalogueError(
      await alice.subscribe({ events: ["MessageCommitted", "MessageCommitted"] }, sink),
      "ValidationFailed",
    );
    expectCatalogueError(
      await alice.subscribe({ events: ["MessageCommitted"], since: "bad-cursor" }, sink),
      "ValidationFailed",
    );
    await cap.close();
  });
});

describe("authentication at the door", () => {
  it("unknown credentials are a typed rejection, never a throw", async () => {
    const cap = createEmbeddedMessaging({
      authority: {
        principals: [{ token: "tok-alice", personId: ALICE, roles: ["Worker"] }],
        roleGrants: DEFAULT_ROLE_GRANTS,
      },
    });
    const rejected = await cap.authenticate({ token: "wrong" });
    assert.equal(rejected.kind, "rejected");
    if (rejected.kind === "rejected") {
      assert.ok(CATALOGUE.includes(rejected.error.name));
      assert.equal(rejected.error.name, "NotAuthenticated");
    }
    const malformed = await cap.authenticate(42);
    assert.equal(malformed.kind, "rejected");
    await cap.close();
  });
});
