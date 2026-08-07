/**
 * P4 — the Plan §15 proof that seals slice S2 (Rooms): a second capability
 * (the stand-in Mission Rooms capability, tests/capability/missionRooms.ts)
 * references Messaging Threads/Messages BY ID ONLY and posts mission events
 * through the public SendMessage door — without owning or copying Messages.
 *
 * What this suite proves, through the door:
 *  1. Room truth is the capability's own, expressed as membership adapter
 *     config (the DEC-07-style pattern); the composition root provisions the
 *     room Thread at startup (Store-Seam §11.4) and the capability learns the
 *     minted threadId through the public ListThreadsForPerson query.
 *  2. The capability posts a sequence of mission events; a human member of
 *     the mission room receives them — addressed-lane delivery with a REAL
 *     adapter effect (DEC-08) AND observation-lane subscription push
 *     (MSG-023) — the MSG-002/003 shape exercised end-to-end by a second
 *     capability (one Message, one Thread, one Delivery per member, DEC-05).
 *  3. Integrity without copying: the capability re-renders its room view
 *     from GetMessages + its own ID references, and the rendered content
 *     matches what it posted. The guarantee is CONVENTION + the render path,
 *     not structure: the record store holds ID references + the capability's
 *     own authored metadata (asserted at the value level below), and the
 *     view is rebuilt from Messaging on every render — the store is never
 *     the content source, so a copy could never serve as truth.
 *  4. R3/R4 hold for capability-posted rooms: a non-member's reads and send
 *     are refused with typed NotAuthorized.
 *  5. Architecture: the stand-in module crosses the public surface only —
 *     its compiled form has ZERO runtime messaging imports (the
 *     external-chief discipline), and its TS source imports nothing private.
 *  6. The same scenario rides the standalone DEC-17 wire protocol (S2-a
 *     already proved room posts over the wire; P4 proves the CAPABILITY
 *     pattern over it).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEmbeddedMessaging,
  createMemoryPresenceTransport,
  createSeededClock,
  DEFAULT_ROLE_GRANTS,
} from "../../public/index.js";
import type {
  AuthorityConfig,
  Cursor,
  Message,
  MessagePage,
  MessagingSession,
  PersonId,
  SendAccepted,
  SubscriptionMessage,
  SubscriptionSink,
  ThreadListResult,
} from "../../public/index.js";
import {
  ALICE,
  ADMIN,
  BOB,
  expectError,
  flushMicrotasks,
  ManualScheduler,
  sessionFor,
  TEST_RETRY_POLICY,
  unwrap,
} from "../core/helpers.js";
import { ExternalChief } from "../standalone/external-chief.js";
import type { ExternalCommandError } from "../standalone/external-chief.js";
import { spawnStandaloneServer } from "../standalone/spawned-server.js";
import { MissionRoomsCapability, MISSION_ROOMS_AUTHORITY } from "../capability/missionRooms.js";
import type { MissionMessagingPort } from "../capability/missionRooms.js";

// Source lives at tests/slow/, compiled output at dist/tests/slow/ — the
// depth differs, so resolve the package root by walking up to tsconfig.json.
const packageRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "tsconfig.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package root not found from ${dir}`);
    dir = parent;
  }
  return dir;
})();

/** The mission capability's own principal — it posts as itself, never as a human. */
const MISSION_RUNNER = "person_missionrunner" as PersonId;

/** The mission the stand-in capability owns (its roster IS the room truth). */
const MISSION = { missionId: "mission-42", members: [MISSION_RUNNER, ALICE, BOB] as PersonId[] };

/** The same authority config in both modes: the runner + two humans + an outsider. */
const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-mission-runner", personId: MISSION_RUNNER, roles: ["Worker"] },
    { token: "tok-alice", personId: ALICE, roles: ["Worker"] },
    { token: "tok-bob", personId: BOB, roles: ["Worker"] },
    { token: "tok-admin", personId: ADMIN, grants: ["policy.admin"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

// --- the port adapters: same capability, two integration modes ----------------

/** Embedded mode: the port over the authenticated session door. */
function sessionPort(session: MessagingSession): MissionMessagingPort {
  return {
    async listThreads() {
      return unwrap(await session.listThreadsForPerson({})).threads;
    },
    async getMessages(threadId) {
      // Follow the cursor: the room view needs the FULL history, not page one.
      const messages: Message[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = unwrap(
          await session.getMessages({ threadId, ...(cursor !== undefined ? { cursor } : {}) }),
        );
        messages.push(...page.messages);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return messages;
    },
    async send(input) {
      return unwrap(await session.sendMessage(input));
    },
  };
}

/**
 * The wire port's failure shape: the typed contract outcome carried through
 * (name + fields + retryable), NOT collapsed into a message string — the
 * tests assert on the typed error the way a real capability would.
 */
class TestWireError extends Error {
  override readonly name: string;
  readonly retryable: boolean;
  readonly fields: Record<string, unknown>;

  constructor(operation: string, error: ExternalCommandError) {
    super(`${operation}: ${error.name}: ${error.message}`);
    this.name = error.name;
    this.retryable = error.retryable;
    this.fields = error.fields;
  }
}

/**
 * Standalone mode: the port over the DEC-17 wire protocol client. The wire
 * client is schema-less by design (an external principal has no Novakai
 * objects); the `as` casts assert the published result shapes, which the
 * contract suite verifies against the schema.
 */
function wirePort(chief: ExternalChief): MissionMessagingPort {
  return {
    async listThreads() {
      const outcome = await chief.query("ListThreadsForPerson", {});
      if (!outcome.ok) throw new TestWireError("ListThreadsForPerson", outcome.error);
      return (outcome.result as ThreadListResult).threads;
    },
    async getMessages(threadId) {
      // Follow the cursor: the room view needs the FULL history, not page one.
      const messages: Message[] = [];
      let cursor: Cursor | undefined;
      do {
        const outcome = await chief.query("GetMessages", {
          threadId,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (!outcome.ok) throw new TestWireError("GetMessages", outcome.error);
        const page = outcome.result as MessagePage;
        messages.push(...page.messages);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return messages;
    },
    async send(input) {
      const outcome = await chief.command("SendMessage", input);
      if (!outcome.ok) throw new TestWireError("SendMessage", outcome.error);
      return outcome.result as SendAccepted;
    },
  };
}

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

function makeP4Harness(capability: MissionRoomsCapability) {
  const clock = createSeededClock({ seed: "p4" });
  const transport = createMemoryPresenceTransport({ kind: "ws" });
  const scheduler = new ManualScheduler();
  const cap = createEmbeddedMessaging({
    clock,
    transports: [transport],
    scheduler,
    retryPolicy: TEST_RETRY_POLICY,
    authority: AUTHORITY,
    // The capability's roster truth enters as membership adapter config —
    // the DEC-07-style pattern (never Messaging core).
    membership: { rooms: capability.declareRooms() },
  });
  return { cap, transport };
}

describe("P4 — Mission Rooms references Threads/Messages by ID and posts mission events (embedded)", () => {
  it("provision → post mission events → member delivery + push → integrity render → non-member refused", async () => {
    const capability = new MissionRoomsCapability([MISSION]);
    const { cap, transport } = makeP4Harness(capability);
    await cap.start(); // Store-Seam §11.4: the root provisions the capability's room Thread

    const runner = await sessionFor(cap, "tok-mission-runner");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    const admin = await sessionFor(cap, "tok-admin");

    // 1. The capability learns its provisioned threadId via the public surface.
    await capability.attach(sessionPort(runner));
    const roomId = capability.threadIdFor(MISSION.missionId);
    const roomView = unwrap(await runner.getThread({ threadId: roomId }));
    assert.equal(roomView.threadKind, "mission");
    assert.equal(roomView.room?.authority, MISSION_ROOMS_AUTHORITY);
    assert.equal(roomView.room?.externalId, MISSION.missionId);

    // The human members receive the runner (first contact is deliberate, DEC-14).
    unwrap(await alice.setContactPolicy({ allowlist: [MISSION_RUNNER], defaultRule: "deny" }));
    unwrap(await bob.setContactPolicy({ allowlist: [MISSION_RUNNER], defaultRule: "deny" }));

    // Alice is live: a real presence (addressed lane) + a subscription (observation lane).
    const alicePresence = unwrap(await alice.openPresence({ transport: "ws" }));
    const aliceStream = collectSink();
    unwrap(await alice.subscribe({ events: ["MessageCommitted"] }, aliceStream.sink));

    // 2. The capability posts its mission events — Messages through SendMessage.
    const posted = [
      await capability.postEvent(MISSION.missionId, "mission-started", "alpha team assembled"),
      await capability.postEvent(MISSION.missionId, "phase-completed", "recon complete"),
      await capability.postEvent(MISSION.missionId, "mission-completed", "objective met"),
    ];
    await flushMicrotasks();

    // DEC-05 end-to-end by a second capability: one Message per event, one
    // Thread, one Delivery per snapshotted member — and alice's Delivery
    // settled delivered on a REAL adapter effect (DEC-08, I11).
    for (const record of posted) {
      assert.ok(
        transport.effects.some(
          (effect) =>
            effect.presenceId === alicePresence.presenceId &&
            effect.payload.message.id === record.messageId,
        ),
        `alice was delivered mission event ${record.eventId} via a real transport effect`,
      );
      const deliveries = unwrap(await alice.getDelivery({ messageId: record.messageId }));
      assert.equal(deliveries.deliveries.length, 3, "one Delivery per snapshotted room member");
      assert.equal(
        deliveries.deliveries.find((delivery) => delivery.recipientId === ALICE)?.state,
        "delivered",
      );
    }

    // MSG-023: alice was PUSHED the room facts on her subscription — no polling.
    await cap.pumpEvents();
    await flushMicrotasks();
    const pushedMessageIds = aliceStream.frames
      .filter((frame) => frame.kind === "event")
      .map((frame) => (frame.event as { message?: { id: string } }).message?.id);
    for (const record of posted) {
      assert.ok(
        pushedMessageIds.includes(record.messageId),
        `alice's subscription was pushed MessageCommitted for ${record.eventId}`,
      );
    }

    // Sender identity is the capability's authenticated principal (DEC-11, I4).
    const history = unwrap(await alice.getMessages({ threadId: roomId }));
    assert.equal(history.messages.length, 3);
    assert.ok(history.messages.every((message) => message.senderId === MISSION_RUNNER));

    // 3. THE INTEGRITY ASSERTION (§15): the capability re-renders its room
    // view purely from Messaging's GetMessages + its own ID references — and
    // the rendered content matches what it posted. It never needed to copy.
    const view = await capability.renderRoomView(MISSION.missionId);
    assert.deepEqual(
      view.map((entry) => entry.eventId),
      posted.map((record) => record.eventId),
      "the render is keyed by the capability's own event references, in Thread order",
    );
    assert.deepEqual(
      view.map((entry) => entry.text),
      posted.map((record) => `[${record.kind}] ${record.payloadSummary}`),
      "the rendered content is Messaging's authoritative content — matching what was posted",
    );

    // The anti-copy rule, honestly stated. Nothing STRUCTURAL prevents a copy
    // (payloadSummary is a free string), so assert the convention at the value
    // level: (a) the store holds no body/content-shaped field at all, and
    // (b) what it does hold is the capability's OWN authored summary — never
    // equal to any posted Message body. The render above is the real
    // integrity mechanism: content is re-read from Messaging every render.
    const RECORD_KEYS = ["duplicate", "eventId", "kind", "messageId", "payloadSummary", "threadId"];
    const postedBodies = history.messages.map((message) => message.body.text);
    for (const record of capability.records()) {
      assert.deepEqual(
        Object.keys(record).sort(),
        RECORD_KEYS,
        "a mission-event record is IDs + own metadata only (no body/content-shaped field)",
      );
      assert.ok(
        !postedBodies.includes(record.payloadSummary),
        "payloadSummary is the capability's own authored summary — not a copy of any posted Message body",
      );
    }

    // 4. R3/R4 hold for capability-posted rooms: the non-member is refused.
    assert.equal(expectError(await admin.getThread({ threadId: roomId })).name, "NotAuthorized");
    assert.equal(expectError(await admin.getMessages({ threadId: roomId })).name, "NotAuthorized");
    assert.equal(
      expectError(
        await admin.sendMessage({
          address: `thread:${roomId}`,
          body: { text: "intruder" },
          priority: "normal",
          clientMessageId: "p4-intruder",
        }),
      ).name,
      "NotAuthorized",
    );
    const adminList = unwrap(await admin.listThreadsForPerson({}));
    assert.ok(
      !adminList.threads.some((thread) => thread.id === roomId),
      "the non-member's listing does not include the mission room",
    );
    await cap.close();
  });

  it("DEC-13: a retried post of the same event never duplicates; same eventId with a different payload is an IdempotencyConflict", async () => {
    const capability = new MissionRoomsCapability([MISSION]);
    const { cap } = makeP4Harness(capability);
    await cap.start();
    const runner = await sessionFor(cap, "tok-mission-runner");
    await capability.attach(sessionPort(runner));
    const roomId = capability.threadIdFor(MISSION.missionId);

    // Post the event, then RETRY it: the same durable eventId yields the same
    // clientMessageId with the same payload — Messaging returns the ORIGINAL
    // acceptance instead of committing a second Message.
    const eventId = `${MISSION.missionId}/evt_1`;
    const first = await capability.postEvent(
      MISSION.missionId,
      "mission-started",
      "alpha team assembled",
      eventId,
    );
    const retry = await capability.postEvent(
      MISSION.missionId,
      "mission-started",
      "alpha team assembled",
      eventId,
    );
    assert.equal(retry.messageId, first.messageId, "the retry resolves to the SAME Message");
    assert.equal(
      retry.duplicate,
      true,
      "the duplicate outcome surfaces through the port (SendAccepted.duplicate)",
    );
    const history = unwrap(await runner.getMessages({ threadId: roomId }));
    assert.equal(history.messages.length, 1, "ONE message in the room after the retried post");
    assert.equal(
      capability.records().filter((record) => record.eventId === eventId).length,
      1,
      "the capability keeps ONE record for the retried event",
    );

    // Same eventId → same clientMessageId, DIFFERENT payload → the typed
    // IdempotencyConflict surfaces through the port (not a silent overwrite).
    await assert.rejects(
      () => capability.postEvent(MISSION.missionId, "phase-completed", "tampered payload", eventId),
      /IdempotencyConflict/,
    );
    const afterConflict = unwrap(await runner.getMessages({ threadId: roomId }));
    assert.equal(afterConflict.messages.length, 1, "the conflicting post committed nothing");
    await cap.close();
  });
});

describe("P4 — architecture: the second capability crosses the public surface only (G4, MSG-013)", () => {
  // SCANNER LIMITATIONS (tripwire, not proof): this regex matches LITERAL
  // specifiers only — import(variable), createRequire, or eval-constructed
  // imports evade it, and the TS-source scan below judges RELATIVE
  // specifiers only (bare package specifiers are ignored). The backstop is
  // the compiled-artifact assertion: the built stand-in has ZERO runtime
  // messaging imports, which no source-level trick can fake.
  const IMPORT_PATTERN =
    /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

  function specifiers(source: string): string[] {
    const out: string[] = [];
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (specifier !== undefined) out.push(specifier);
    }
    return out;
  }

  it("the compiled stand-in has ZERO runtime messaging imports (type-only public references erase)", () => {
    const compiledPath = join(packageRoot, "dist", "tests", "capability", "missionRooms.js");
    const runtimeImports = specifiers(readFileSync(compiledPath, "utf8")).filter(
      (specifier) => !specifier.startsWith("node:"),
    );
    assert.deepEqual(
      runtimeImports,
      [],
      "like the external-chief client, the second capability needs no Novakai-specific runtime object",
    );
  });

  it("the stand-in source imports only the published public/ surface — never core/seams/adapters/protocol internals", () => {
    const sourcePath = join(packageRoot, "tests", "capability", "missionRooms.ts");
    const relativeImports = specifiers(readFileSync(sourcePath, "utf8")).filter((specifier) =>
      specifier.startsWith("."),
    );
    assert.ok(relativeImports.length > 0, "the scan actually found the module's imports");
    for (const specifier of relativeImports) {
      const resolved = resolve(dirname(sourcePath), specifier);
      const rel = relative(packageRoot, resolved).split(sep).join("/");
      assert.ok(
        rel.startsWith("public/"),
        `private import crossed the boundary: ${specifier} (resolves to ${rel})`,
      );
    }
  });
});

describe("P4 — the same capability scenario rides the standalone DEC-17 wire protocol", () => {
  it("provision → post → member pushed over the wire → integrity render → non-member refused", async () => {
    const capability = new MissionRoomsCapability([MISSION]);
    const server = await spawnStandaloneServer({
      authority: AUTHORITY,
      serverOptions: { membership: { rooms: capability.declareRooms() } },
    });
    const runner = await ExternalChief.connect(server.port);
    const alice = await ExternalChief.connect(server.port);
    const admin = await ExternalChief.connect(server.port);
    try {
      assert.equal((await runner.authenticate("tok-mission-runner")).ok, true);
      assert.equal((await alice.authenticate("tok-alice")).ok, true);
      assert.equal((await admin.authenticate("tok-admin")).ok, true);

      // The capability attaches over the wire: discovery is the published
      // ListThreadsForPerson query — no Novakai-specific object.
      await capability.attach(wirePort(runner));
      const roomId = capability.threadIdFor(MISSION.missionId);

      // Alice receives the runner and connects her delivery lane.
      const policy = await alice.command("SetContactPolicy", {
        allowlist: [MISSION_RUNNER],
        defaultRule: "deny",
      });
      assert.ok(policy.ok, `SetContactPolicy failed: ${policy.ok === false && policy.error.message}`);
      await alice.openPresence();

      // The capability posts mission events over the wire; alice is PUSHED
      // the addressed-lane delivery (MSG-023 — never polled).
      const firstDelivery = alice.waitForDelivery(
        (message) => message["threadId"] === roomId,
      );
      const first = await capability.postEvent(MISSION.missionId, "mission-started", "wire alpha");
      const pushed = await firstDelivery;
      assert.equal(
        (pushed["message"] as { id: string; body: { text: string } }).id,
        first.messageId,
      );
      assert.equal(
        (pushed["message"] as { body: { text: string } }).body.text,
        "[mission-started] wire alpha",
      );
      const second = await capability.postEvent(MISSION.missionId, "mission-completed", "wire omega");

      // The integrity assertion over the wire: the room view re-renders from
      // GetMessages + the capability's ID references, matching what it posted.
      const view = await capability.renderRoomView(MISSION.missionId);
      assert.deepEqual(
        view.map((entry) => entry.eventId),
        [first.eventId, second.eventId],
      );
      assert.deepEqual(
        view.map((entry) => entry.text),
        ["[mission-started] wire alpha", "[mission-completed] wire omega"],
      );

      // R3/R4 over the wire: the non-member's send and read are refused.
      const deniedSend = await admin.command("SendMessage", {
        address: `thread:${roomId}`,
        body: { text: "intruder" },
        priority: "normal",
        clientMessageId: "p4-ws-intruder",
      });
      assert.equal(deniedSend.ok, false);
      if (!deniedSend.ok) assert.equal(deniedSend.error.name, "NotAuthorized");
      const deniedRead = await admin.query("GetMessages", { threadId: roomId });
      assert.equal(deniedRead.ok, false);
      if (!deniedRead.ok) assert.equal(deniedRead.error.name, "NotAuthorized");

      // The port carries the typed outcome through: a refused call rejects
      // with TestWireError (name + retryable + fields), not a flattened string.
      await assert.rejects(
        () => wirePort(admin).getMessages(roomId),
        (error: unknown) =>
          error instanceof TestWireError &&
          error.name === "NotAuthorized" &&
          error.retryable === false,
      );
    } finally {
      await runner.close();
      await alice.close();
      await admin.close();
      await server.stop();
    }
  });
});
