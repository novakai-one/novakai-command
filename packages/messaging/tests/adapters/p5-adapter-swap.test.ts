/**
 * P5 — the adapter-swap proof (Plan §15, DEC-10, guarantee 10): "in-memory
 * store ↔ JSONL store, and PTY transport ↔ WS transport, with the shared
 * contract suites passing unchanged."
 *
 * The proof has two halves:
 *
 *  1. THE SHARED SUITES ARE THE SWAP. tests/adapters/store-contract.test.ts
 *     runs ONE suite against storeAdapterFactories (memory + jsonl);
 *     tests/adapters/transport-contract.test.ts runs ONE suite against
 *     transportAdapterFactories (memory + pty + ws — the WS leg over a real
 *     localhost socket, the PTY leg over a fake child). Neither suite
 *     mentions adapter mechanics: the factories abstract construction, so
 *     the suites pass UNCHANGED against every adapter. The manifest leg
 *     below machine-asserts that every v1 adapter is in its suite's factory
 *     array — an adapter that isn't covered fails HERE, loudly.
 *
 *  2. CAPABILITY-LEVEL SWAP. The SAME end-to-end scenario runs through the
 *     public contract against (a) store-memory and store-jsonl, and (b) the
 *     memory and PTY transports — and produces IDENTICAL observable outcomes
 *     (acceptance shapes, delivery states, idempotency, template behaviour).
 *     Behaviour lives in the core; adapters vary only the effect (DEC-10).
 *     The NAMED PTY↔WS pair also runs capability-level below (audit F7):
 *     the identical scenario through the public contract over a real
 *     localhost WS socket and a fake PTY child, asserting an identical
 *     observable outcome vector. (The WS transport's fuller capability-level
 *     integration remains the entire standalone mode — tests/standalone/*,
 *     P1/P2/P3 over real WS sockets.)
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";

import {
  createEmbeddedMessaging,
  createMemoryPresenceTransport,
  createMemoryStore,
  createPtyPresenceTransport,
  createSeededClock,
  DEFAULT_ROLE_GRANTS,
} from "../../contract/index.js";
import { openJsonlStore } from '../../adapters/store-jsonl.js';
import type { AuthorityConfig, EmbeddedMessaging, MessagingStore } from "../../contract/index.js";
import {
  ADMIN,
  ALICE,
  BOB,
  ManualScheduler,
  TEST_RETRY_POLICY,
  sessionFor,
  unwrap,
} from "../core/helpers.js";
import { storeAdapterFactories, transportAdapterFactories } from "./adapterFactories.js";
import { FakePtyChild } from "./fakePtyChild.js";
import { createWsPresenceTransport } from "../../adapters/presence-transport-ws.js";

const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-alice", personId: ALICE, roles: ["Worker"] },
    { token: "tok-bob", personId: BOB, roles: ["Worker"] },
    { token: "tok-admin", personId: ADMIN, grants: ["template.write"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

function makeCap(overrides: {
  store?: MessagingStore;
  transports?: Parameters<typeof createEmbeddedMessaging>[0]["transports"];
}): EmbeddedMessaging {
  return createEmbeddedMessaging({
    clock: createSeededClock({ seed: "p5" }),
    scheduler: new ManualScheduler(),
    retryPolicy: TEST_RETRY_POLICY,
    authority: AUTHORITY,
    ...(overrides.store !== undefined ? { store: overrides.store } : {}),
    ...(overrides.transports !== undefined
      ? { transports: overrides.transports }
      : { transports: [createMemoryPresenceTransport({ kind: "ws" })] }),
  });
}

describe("P5 — adapter swap (DEC-10, guarantee 10)", () => {
  it("manifest: every v1 adapter runs its shared contract suite (store memory↔jsonl, transport memory↔pty↔ws)", () => {
    assert.deepEqual(
      storeAdapterFactories.map((factory) => factory.name).sort(),
      ["store-jsonl", "store-memory"],
      "the store suite covers exactly the two store adapters",
    );
    assert.deepEqual(
      transportAdapterFactories.map((factory) => factory.name).sort(),
      ["presence-transport-memory", "presence-transport-pty", "presence-transport-ws"],
      "the transport suite covers exactly the three transport adapters",
    );
    // Structural honesty: the suites iterate THESE arrays in their own
    // modules — importing the same bindings here proves the manifest and the
    // suites can never drift apart.
    assert.ok(storeAdapterFactories.length >= 2 && transportAdapterFactories.length >= 2);
  });

  it("store swap: the SAME scenario (incl. templates) yields IDENTICAL observable outcomes on memory and jsonl", async () => {
    async function scenario(makeStore: () => Promise<{ store: MessagingStore; cleanup: () => void }>) {
      const { store, cleanup } = await makeStore();
      const cap = makeCap({ store });
      try {
        const admin = await sessionFor(cap, "tok-admin");
        const alice = await sessionFor(cap, "tok-alice");
        const bob = await sessionFor(cap, "tok-bob");
        unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

        const created = unwrap(
          await admin.upsertTemplate({
            name: "swap",
            bindings: [{ field: "text", path: "body.text" }],
          }),
        );
        const sent = unwrap(
          await alice.sendFromTemplate({
            address: `person:${BOB}`,
            templateId: created.templateId,
            fields: { text: "same on every store" },
            priority: "normal",
            clientMessageId: "p5-store-1",
          }),
        );
        const retry = unwrap(
          await alice.sendFromTemplate({
            address: `person:${BOB}`,
            templateId: created.templateId,
            fields: { text: "same on every store" },
            priority: "normal",
            clientMessageId: "p5-store-1",
          }),
        );
        const inbox = unwrap(await bob.getInbox({}));
        const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));
        const templates = unwrap(await alice.listTemplates({}));

        // The observable outcome vector — adapter-independent truth only.
        return {
          templateRevision: created.revision,
          accepted: {
            duplicate: sent.duplicate ?? false,
            urgentDowngraded: sent.urgentDowngraded ?? false,
          },
          retryDuplicate: retry.duplicate ?? false,
          retrySameMessage: retry.messageId === sent.messageId,
          inboxCount: inbox.messages.length,
          deliveryStates: deliveries.deliveries.map((delivery) => delivery.state),
          templateNames: templates.templates.map((template) => template.name),
          renderedText: inbox.messages[0]?.body.text ?? null,
          templateRefStamped: inbox.messages[0]?.template?.templateId === created.templateId,
        };
      } finally {
        await cap.close();
        cleanup();
      }
    }

    const memoryOutcome = await scenario(() => {
      const clock = createSeededClock({ seed: "p5-mem" });
      return Promise.resolve({ store: createMemoryStore(clock), cleanup: () => {} });
    });

    const dir = mkdtempSync(join(tmpdir(), "nvk-p5-store-"));
    const jsonlOutcome = await scenario(async () => {
      const clock = createSeededClock({ seed: "p5-jsonl" });
      const store = await openJsonlStore(clock, { path: join(dir, "store.jsonl") });
      return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    });

    assert.deepEqual(jsonlOutcome, memoryOutcome, "DEC-10: behaviour is owned by the core, not the store adapter");
  });

  it("transport swap: the SAME send is delivered through memory and PTY transports with identical contract truth", async () => {
    async function scenario(kind: "memory" | "pty") {
      const ptyTransport = kind === "pty" ? createPtyPresenceTransport({ livenessIntervalMs: 0 }) : undefined;
      const memoryTransport =
        kind === "memory" ? createMemoryPresenceTransport({ kind: "ws" }) : undefined;
      const transport = ptyTransport ?? (memoryTransport as NonNullable<typeof memoryTransport>);
      const cap = makeCap({ transports: [transport] });
      const ptyChild = new FakePtyChild();
      try {
        const alice = await sessionFor(cap, "tok-alice");
        const bob = await sessionFor(cap, "tok-bob");
        unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
        const opened = unwrap(await bob.openPresence({ transport: kind === "pty" ? "pty" : "ws" }));
        if (ptyTransport) {
          assert.equal(ptyTransport.bind(opened.presenceId, ptyChild), true, "the host binds the PTY lane");
        }

        const sent = unwrap(
          await alice.sendMessage({
            address: `person:${BOB}`,
            body: { text: `delivered via ${kind}` },
            priority: "normal",
            clientMessageId: `p5-transport-${kind}`,
          }),
        );
        const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));

        // The contract truth is identical; only the EFFECT evidence differs
        // (adapter-owned, DEC-10): recorded effect vs bytes in the PTY.
        const effectEvidence =
          kind === "memory"
            ? (memoryTransport?.effects.length ?? 0) === 1
            : (ptyChild.receivedJson() as { message?: { body?: { text?: string } } }[])[0]?.message
                ?.body?.text === `delivered via ${kind}`;
        return {
          deliveryStates: deliveries.deliveries.map((delivery) => delivery.state),
          accepted: { duplicate: sent.duplicate ?? false },
          effectEvidence,
        };
      } finally {
        await cap.close();
        if (ptyTransport) await ptyTransport.closeAll();
      }
    }

    const memoryOutcome = await scenario("memory");
    const ptyOutcome = await scenario("pty");

    assert.deepEqual(memoryOutcome.deliveryStates, ["delivered"]);
    assert.deepEqual(ptyOutcome.deliveryStates, ["delivered"]);
    assert.deepEqual(
      { deliveryStates: ptyOutcome.deliveryStates, accepted: ptyOutcome.accepted },
      { deliveryStates: memoryOutcome.deliveryStates, accepted: memoryOutcome.accepted },
      "the contract truth is adapter-independent",
    );
    assert.equal(memoryOutcome.effectEvidence, true, "memory: the effect was recorded (G10)");
    assert.equal(ptyOutcome.effectEvidence, true, "pty: the bytes reached the child (G10)");
  });

  it("transport swap (the NAMED P5 pair, audit F7): the SAME scenario on PTY and WS transports yields IDENTICAL contract truth", async () => {
    async function scenario(kind: "pty" | "ws") {
      const ptyTransport = kind === "pty" ? createPtyPresenceTransport({ livenessIntervalMs: 0 }) : undefined;
      const wsTransport = kind === "ws" ? createWsPresenceTransport({ livenessIntervalMs: 0 }) : undefined;
      // WS leg plumbing (adapter-owned): a real localhost server observes the
      // frames; the scenario itself never mentions it.
      let wss: WebSocketServer | undefined;
      let wsPort = 0;
      const wsReceived: unknown[] = [];
      if (kind === "ws") {
        wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        await new Promise<void>((resolve) => {
          wss?.once("listening", resolve);
        });
        wsPort = (wss.address() as AddressInfo).port;
        wss.on("connection", (socket) => {
          socket.on("message", (data) => {
            wsReceived.push(JSON.parse(data.toString()) as unknown);
          });
        });
      }
      const transport = (ptyTransport ?? wsTransport) as NonNullable<typeof ptyTransport> | NonNullable<typeof wsTransport>;
      const cap = makeCap({ transports: [transport] });
      const ptyChild = new FakePtyChild();
      try {
        const alice = await sessionFor(cap, "tok-alice");
        const bob = await sessionFor(cap, "tok-bob");
        unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
        const opened = unwrap(await bob.openPresence({ transport: kind }));
        if (ptyTransport) {
          assert.equal(ptyTransport.bind(opened.presenceId, ptyChild), true, "the host binds the PTY lane");
        } else if (wsTransport) {
          const socket = new WebSocket(`ws://127.0.0.1:${String(wsPort)}`);
          await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          });
          wsTransport.accept(socket);
          assert.equal(wsTransport.bind(opened.presenceId, socket), true, "the protocol layer binds the WS lane");
        }

        const sent = unwrap(
          await alice.sendMessage({
            address: `person:${BOB}`,
            body: { text: `delivered via ${kind}` },
            priority: "normal",
            clientMessageId: `p5-pty-ws-${kind}`,
          }),
        );
        const deliveries = unwrap(await alice.getDelivery({ messageId: sent.messageId }));

        // The contract truth is identical; only the EFFECT evidence differs
        // (adapter-owned, DEC-10): bytes in the PTY vs frames on the wire.
        // The server's message event is async w.r.t. the send confirm —
        // wait (bounded) for the frame to actually arrive.
        for (let waited = 0; kind === "ws" && wsReceived.length === 0 && waited < 1_000; waited += 10) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const effectEvidence =
          kind === "pty"
            ? (ptyChild.receivedJson() as { message?: { body?: { text?: string } } }[])[0]?.message
                ?.body?.text === `delivered via ${kind}`
            : (wsReceived as { message?: { body?: { text?: string } } }[])[0]?.message?.body?.text ===
              `delivered via ${kind}`;
        return {
          deliveryStates: deliveries.deliveries.map((delivery) => delivery.state),
          accepted: { duplicate: sent.duplicate ?? false },
          effectEvidence,
        };
      } finally {
        await cap.close();
        if (ptyTransport) await ptyTransport.closeAll();
        if (wsTransport) await wsTransport.closeAll();
        if (wss) {
          await new Promise<void>((resolve) => {
            wss?.close(() => resolve());
          });
        }
      }
    }

    const ptyOutcome = await scenario("pty");
    const wsOutcome = await scenario("ws");

    assert.deepEqual(ptyOutcome.deliveryStates, ["delivered"]);
    assert.deepEqual(wsOutcome.deliveryStates, ["delivered"]);
    assert.deepEqual(
      { deliveryStates: ptyOutcome.deliveryStates, accepted: ptyOutcome.accepted },
      { deliveryStates: wsOutcome.deliveryStates, accepted: wsOutcome.accepted },
      "PTY↔WS: the observable outcome vector is adapter-independent (DEC-10, guarantee 10)",
    );
    assert.equal(ptyOutcome.effectEvidence, true, "pty: the bytes reached the child (G10)");
    assert.equal(wsOutcome.effectEvidence, true, "ws: the frame reached the wire (G10)");
  });
});
