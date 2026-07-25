/**
 * P6 harness (Plan §15 P6, §10 verification promise): the FULL Messaging
 * capability running on in-memory everything — store-memory, presence-
 * transport-memory, clock-seeded, authority-config — with zero production
 * infrastructure, zero filesystem, zero network. The whole S1 behaviour set
 * is exercised through the embedded composition root: discovery, auth,
 * presence lifecycle, contact policy, DND hold/release, urgent + override
 * (W1 both paths), two-way conversation, every S1 query, the Subscribe push
 * stream, idempotent retry, and the DEC-21 recovery sweep handle.
 *
 * This is the "runs without the primary host" evidence: nothing here touches
 * Novakai Command, a socket, or a disk — the capability's behaviour is owned
 * by the core, not by any adapter (DEC-10).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEmbeddedMessaging,
  createMemoryPresenceTransport,
  createMemoryStore,
  createSeededClock,
  DEFAULT_ROLE_GRANTS,
} from "../../public/index.js";
import type {
  EmbeddedMessaging,
  MessagingSession,
  SubscriptionMessage,
  SubscriptionSink,
} from "../../public/index.js";
import {
  ALICE,
  ADMIN,
  BOB,
  CHIEF,
  ManualScheduler,
  TEST_RETRY_POLICY,
  expectError,
  flushMicrotasks,
  sendInput,
  unwrap,
} from "../core/helpers.js";

/**
 * The P6 wiring: every seam satisfied by its in-memory/local adapter.
 * Constructed explicitly (not via the helper defaults) so the harness
 * document its own independence: no file path, no port, no host process.
 */
function makeP6(): { cap: EmbeddedMessaging } {
  const clock = createSeededClock({ seed: "p6" });
  const store = createMemoryStore(clock);
  const transport = createMemoryPresenceTransport({ kind: "ws" });
  const cap = createEmbeddedMessaging({
    clock,
    store,
    transports: [transport],
    scheduler: new ManualScheduler(),
    retryPolicy: TEST_RETRY_POLICY,
    authority: {
      principals: [
        { token: "tok-alice", personId: ALICE, roles: ["Worker"] },
        { token: "tok-bob", personId: BOB, roles: ["Worker"] },
        { token: "tok-chief", personId: CHIEF, roles: ["Chief"] },
        { token: "tok-admin", personId: ADMIN, grants: ["template.write"] },
      ],
      roleGrants: DEFAULT_ROLE_GRANTS,
    },
  });
  return { cap };
}

async function session(cap: EmbeddedMessaging, token: string): Promise<MessagingSession> {
  const auth = await cap.authenticate({ token });
  assert.equal(auth.kind, "authenticated", `${token} authenticates`);
  if (auth.kind !== "authenticated") throw new Error("unreachable");
  return auth.session;
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

describe("P6 — the full capability on in-memory everything", () => {
  it("discovery and authentication need no infrastructure", async () => {
    const { cap } = makeP6();
    const capabilities = cap.getCapabilities();
    assert.equal(capabilities.contractVersion, "1.0.0");
    assert.deepEqual([...capabilities.features].sort(), ["attention", "direct", "rooms", "subscribe", "templates"]);

    assert.equal((await cap.authenticate({ token: "wrong" })).kind, "rejected");
    assert.equal((await cap.authenticate("garbage")).kind, "rejected");
    await cap.close();
  });

  it("presence lifecycle: open, list, close — ephemeral, never an address", async () => {
    const { cap } = makeP6();
    const alice = await session(cap, "tok-alice");

    const opened = unwrap(await alice.openPresence({ transport: "ws", clientLabel: "p6" }));
    assert.ok(opened.presenceId.startsWith("presence_"));
    assert.equal(unwrap(await alice.getPresence({ personId: ALICE })).presences.length, 1);

    unwrap(await alice.closePresence({ presenceId: opened.presenceId }));
    assert.equal(unwrap(await alice.getPresence({ personId: ALICE })).presences.length, 0);
    await cap.close();
  });

  it("two-way conversation: contact policy, both directions, every read query", async () => {
    const { cap } = makeP6();
    const alice = await session(cap, "tok-alice");
    const bob = await session(cap, "tok-bob");

    // DEC-14: first contact is deliberate on both sides.
    assert.equal(
      (await alice.sendMessage(sendInput(`person:${BOB}`, "unsolicited", "p6-pre"))).kind,
      "error",
      "default-deny blocks unsolicited first contact",
    );
    unwrap(await alice.setContactPolicy({ allowlist: [BOB], defaultRule: "deny" }));
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    const out = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "ping", "p6-1")));
    const back = unwrap(await bob.sendMessage(sendInput(`person:${ALICE}`, "pong", "p6-2")));
    assert.equal(back.threadId, out.threadId, "DEC-03: one canonical direct thread");

    // Idempotent retry through the door (DEC-13).
    const retry = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "ping", "p6-1")));
    assert.equal(retry.duplicate, true);
    assert.equal(retry.messageId, out.messageId);

    const thread = unwrap(await alice.getThread({ threadId: out.threadId }));
    assert.equal(thread.id, out.threadId);

    const page = unwrap(await bob.getMessages({ threadId: out.threadId }));
    assert.deepEqual(
      page.messages.map((message) => [message.senderId, message.body.text]),
      [
        [ALICE, "ping"],
        [BOB, "pong"],
      ],
    );

    // Bob never opened a presence: the delivery is pending, never failed
    // (R5 no-presence rule).
    const deliveries = unwrap(await alice.getDelivery({ messageId: out.messageId }));
    assert.deepEqual(
      deliveries.deliveries.map((delivery) => delivery.state),
      ["pending"],
      "bob has no presence yet: pending, never failed",
    );

    const policy = unwrap(await bob.getPolicy({}));
    assert.equal(policy.contact.defaultRule, "deny");
    await cap.close();
  });

  it("W1 on in-memory seams: DND holds, urgent downgrades without the grant, override delivers", async () => {
    const { cap } = makeP6();
    const alice = await session(cap, "tok-alice");
    const chief = await session(cap, "tok-chief");
    const bob = await session(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE, CHIEF], defaultRule: "deny" }));
    unwrap(await bob.setDndPolicy({ enabled: true }));
    await bob.openPresence({ transport: "ws" });

    // Normal priority: held by DND — but nothing is lost (guarantee 6).
    unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "routine", "p6-d1")));
    let delivery = unwrap(await alice.getDelivery({ messageId: (unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "routine2", "p6-d2")))).messageId }));
    assert.equal(delivery.deliveries[0]?.state, "held", "DND holds the push");
    const inbox = unwrap(await bob.getInbox({}));
    assert.ok(
      inbox.messages.some((message) => message.body.text === "routine"),
      "held messages remain pullable",
    );

    // Urgent WITHOUT priority.override: downgrades with a typed outcome (I9).
    const downgraded = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "please?", "p6-d3", "urgent")));
    assert.equal(downgraded.urgentDowngraded, true);

    // Urgent WITH the grant (Chief role): pushes through DND.
    const override = unwrap(await chief.sendMessage(sendInput(`person:${BOB}`, "chief needs you", "p6-d4", "urgent")));
    assert.equal(override.urgentDowngraded, undefined);
    delivery = unwrap(await chief.getDelivery({ messageId: override.messageId }));
    assert.equal(delivery.deliveries[0]?.state, "delivered", "override → real adapter effect (DEC-08)");

    // Release: DND off → held deliveries drain to delivered.
    unwrap(await bob.setDndPolicy({ enabled: false }));
    await flushMicrotasks();
    const drained = unwrap(await alice.getDelivery({
      messageId: downgraded.messageId,
    }));
    assert.equal(drained.deliveries[0]?.state, "delivered", "dnd-released resumes attempts (R5)");
    await cap.close();
  });

  it("the Subscribe stream pushes without polling (MSG-023) — sink = the host's push lane", async () => {
    const { cap } = makeP6();
    const alice = await session(cap, "tok-alice");
    const bob = await session(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    const { sink, frames } = collectSink();
    const handle = unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, sink));
    const accepted = unwrap(await alice.sendMessage(sendInput(`person:${BOB}`, "pushed", "p6-s1")));
    await cap.pumpEvents();
    await flushMicrotasks();

    assert.ok(frames.some((frame) => frame.kind === "started"));
    const event = frames.find((frame) => frame.kind === "event");
    assert.equal(
      ((event?.event as { message?: { id: string } } | undefined)?.message?.id),
      accepted.messageId,
      "the committed fact was pushed to the subscriber",
    );
    await handle.close();
    await cap.close();
  });

  it("the DEC-21 recovery sweep is a composition-owned handle — idempotent, safe with zero pending", async () => {
    const { cap } = makeP6();
    const first = await cap.runRecoverySweep();
    assert.deepEqual(first, { found: 0, settled: 0, failures: [] });
    const second = await cap.runRecoverySweep();
    assert.deepEqual(second, { found: 0, settled: 0, failures: [] });
    await cap.close();
  });

  it("templates end-to-end on in-memory everything (S4): create, send, list, retire — DEC-15/R12/I10", async () => {
    const { cap } = makeP6();
    const admin = await session(cap, "tok-admin");
    const alice = await session(cap, "tok-alice");
    const bob = await session(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    await bob.openPresence({ transport: "ws" });

    // Create (template.write grant) — R12: non-bindable paths rejected.
    assert.equal(
      expectError(await admin.upsertTemplate({ name: "evil", bindings: [{ field: "x", path: "senderId" }] })).name,
      "ValidationFailed",
    );
    const created = unwrap(
      await admin.upsertTemplate({
        name: "standup",
        bindings: [
          { field: "summary", path: "body.text" },
          { field: "ticket", path: "body.fields.ticket" },
        ],
      }),
    );

    // Send from the template — renders and delivers exactly as SendMessage.
    const sent = unwrap(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId: created.templateId,
        fields: { summary: "p6 shipped", ticket: "P6" },
        priority: "normal",
        clientMessageId: "p6-tpl-1",
      }),
    );
    const page = unwrap(await bob.getMessages({ threadId: sent.threadId }));
    assert.equal(page.messages[0]?.body.text, "p6 shipped");
    assert.deepEqual(page.messages[0]?.body.fields, { ticket: "P6" });
    assert.equal(page.messages[0]?.template?.templateId, created.templateId);
    const delivered = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
    assert.equal(delivered.deliveries[0]?.state, "delivered");

    // List (any authenticated principal) and retire (I10: history unchanged).
    assert.equal(unwrap(await alice.listTemplates({})).templates.length, 1);
    unwrap(await admin.retireTemplate({ templateId: created.templateId }));
    assert.equal(unwrap(await alice.listTemplates({})).templates.length, 0);
    assert.equal(unwrap(await alice.listTemplates({ includeRetired: true })).templates.length, 1);
    assert.equal(
      expectError(
        await alice.sendFromTemplate({
          address: `person:${BOB}`,
          templateId: created.templateId,
          fields: { summary: "gone", ticket: "P6" },
          priority: "normal",
          clientMessageId: "p6-tpl-2",
        }),
      ).name,
      "TemplateNotFound",
    );
    // The historical Message is untouched.
    assert.equal(
      unwrap(await bob.getMessages({ threadId: sent.threadId })).messages[0]?.body.text,
      "p6 shipped",
    );
    await cap.close();
  });
});
