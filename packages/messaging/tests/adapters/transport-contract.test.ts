/**
 * Shared presence-transport adapter contract suite (P5, Messaging-Seams §4.3):
 * ONE suite, run against every transport adapter — presence-transport-memory,
 * presence-transport-pty (fake child), and presence-transport-ws (a REAL
 * localhost socket). The transport analogue of the store suite: every adapter
 * must satisfy the §4.1 seam with identical semantics (DEC-10, guarantee 10 —
 * capability behaviour cannot diverge by adapter).
 *
 * Covers: deliver to a bound live lane is a REAL effect carrying the message
 * (G10 — never "written to a buffer"); push carries the SubscriptionMessage
 * verbatim; an unbound lane is a transient failure (the bind window), never a
 * silent no-op; a dead lane NEVER reports effect; and a lane death raises
 * onDisconnect into the core's single presence-close path (R9).
 *
 * The factories (./adapterFactories.ts, shared with the P5 manifest) abstract
 * the per-adapter binding mechanics — the SUITE below never mentions them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { schemaVersion } from "../../public/contract/index.js";
import type { Message, PresenceId, SubscriptionMessage } from "../../public/contract/index.js";
import type { TransportLivenessCallbacks } from "../../seams/presenceTransport.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import { transportAdapterFactories } from "./adapterFactories.js";

// --- fixtures ---------------------------------------------------------------------

const clock = createSeededClock({ seed: "transport-suite" });

function makeMessage(text: string): Message {
  return {
    id: clock.newId("message"),
    kind: "message",
    schemaVersion,
    createdAt: clock.now(),
    threadId: clock.newId("thread"),
    senderId: "person_alice" as Message["senderId"],
    clientMessageId: `cm-${text}` as Message["clientMessageId"],
    sequence: 1 as Message["sequence"],
    priority: "normal",
    body: { text },
  };
}

const PUSH_FRAME: SubscriptionMessage = {
  kind: "started",
  subscriptionId: "subscription_shared" as SubscriptionMessage["subscriptionId"],
};

/** Real lanes (localhost WS) deliver asynchronously — poll briefly for arrival. */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// --- the shared suite ---------------------------------------------------------------

for (const factory of transportAdapterFactories) {
  describe(`presence-transport seam contract suite — ${factory.name}`, () => {
    it("deliver to a bound live lane is a REAL effect carrying the message to the presence (G10/DEC-08)", async () => {
      const handle = await factory.make();
      try {
        const pid = "presence_shared-deliver" as PresenceId;
        await handle.bind(pid);
        const message = makeMessage(`via ${factory.name}`);
        const report = await handle.transport.deliver(pid, { message, priority: "urgent" });
        assert.deepEqual(report, { kind: "effect" }, "the transport confirmed a real effect");
        await waitFor(() => handle.received().length > 0);

        const landed = handle.received() as {
          kind: string;
          message: Message;
          priority: string;
          presenceId: string;
        }[];
        const delivery = landed.find((frame) => frame.kind === "delivery");
        assert.ok(delivery, "the delivery frame landed on the lane");
        assert.equal(delivery.message.id, message.id, "the MESSAGE crosses intact");
        assert.equal(delivery.priority, "urgent", "the priority crosses (MSG-008 steer)");
        assert.equal(delivery.presenceId, pid, "the effect names its Presence (DEC-16 evidence)");
      } finally {
        await handle.cleanup();
      }
    });

    it("push carries the SubscriptionMessage VERBATIM and reports effect (observation lane, R2)", async () => {
      const handle = await factory.make();
      try {
        const pid = "presence_shared-push" as PresenceId;
        await handle.bind(pid);
        const report = await handle.transport.push(pid, PUSH_FRAME);
        assert.deepEqual(report, { kind: "effect" });
        await waitFor(() => handle.received().length > 0);
        const landed = handle.received();
        assert.ok(
          landed.some((frame) => JSON.stringify(frame) === JSON.stringify(PUSH_FRAME)),
          "the SubscriptionMessage crossed verbatim",
        );
      } finally {
        await handle.cleanup();
      }
    });

    it("an unbound lane is a TRANSIENT failure — never a silent no-op, never presence-gone (the bind window)", async () => {
      const handle = await factory.make();
      try {
        const report = await handle.transport.deliver("presence_never-bound" as PresenceId, {
          message: makeMessage("early"),
          priority: "normal",
        });
        assert.equal(report.kind, "failure");
        if (report.kind === "failure") {
          assert.equal(report.retryable, true, "retried inside the R5 budget");
          assert.equal(report.permanent, undefined, "unbound ≠ gone");
        }
      } finally {
        await handle.cleanup();
      }
    });

    it("a dead lane NEVER reports effect (G10) — deliver and push both fail honestly", async () => {
      const handle = await factory.make();
      try {
        const pid = "presence_shared-dead" as PresenceId;
        await handle.bind(pid);
        await handle.killLane(pid);

        const delivered = await handle.transport.deliver(pid, {
          message: makeMessage("too late"),
          priority: "normal",
        });
        assert.equal(delivered.kind, "failure", "no effect is ever reported against a corpse");

        const pushed = await handle.transport.push(pid, PUSH_FRAME);
        assert.equal(pushed.kind, "failure");
      } finally {
        await handle.cleanup();
      }
    });

    it("a lane death raises onDisconnect into the core's single presence-close path (R9)", async () => {
      const handle = await factory.make();
      try {
        const disconnected: PresenceId[] = [];
        const liveness: TransportLivenessCallbacks = {
          onDisconnect(presenceId) {
            disconnected.push(presenceId);
          },
          onLivenessTimeout() {},
        };
        handle.transport.attachLiveness(liveness);
        const pid = "presence_shared-liveness" as PresenceId;
        await handle.bind(pid);
        await handle.killLane(pid);
        assert.deepEqual(disconnected, [pid], "the adapter reported the death — the core never infers liveness");
      } finally {
        await handle.cleanup();
      }
    });
  });
}
