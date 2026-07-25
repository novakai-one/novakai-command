/**
 * W2 crash-retry proof (Plan §16 W2, DEC-09/13/18/20/21, MSG-018/019) —
 * process level. The standalone server runs as a REAL child process on a
 * store-jsonl data path; clients are external (protocol-only, MSG-004). The
 * server is HARD-KILLED with SIGKILL — no graceful shutdown — and restarted
 * on the same journal.
 *
 * What is proven:
 *   1. accept → SIGKILL → restart: the DEC-21 startup sweep runs before
 *      accepting connections (accept-after-sweep); the Message survived the
 *      crash (MSG-019: SendAccepted crossed the durability boundary — the
 *      store's write-then-fsync discipline makes the kill a real test, not a
 *      drill); re-sending the same command (same clientMessageId + same
 *      body) returns the DUPLICATE outcome with the SAME messageId and
 *      sequence — no double commit (DEC-13).
 *   2. SIGKILL INSIDE the commit→effects-settle window, deterministically:
 *      the server runs with the TEST-ONLY effectLegDelayMs fault-injection
 *      hook (F4 — wired through composition, see core/sendPipeline.ts), which
 *      holds the window open for 250 ms per send, so the kill lands mid-
 *      flight on EVERY run. The torn-window recovery is therefore proven
 *      UNCONDITIONALLY: the startup sweep MUST find at least one pending
 *      acceptance and settle every one it found (found > 0, settled ===
 *      found, zero failures), and the retry of every in-flight command
 *      converges to exactly one Message per clientMessageId.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROLE_GRANTS } from "../../public/index.js";
import type { AuthorityConfig } from "../../public/index.js";
import { ExternalChief } from "./external-chief.js";
import { spawnStandaloneServer } from "./spawned-server.js";
import type { SpawnedServer, SweepReport } from "./spawned-server.js";

const CHIEF = "person_chief";
const WORKER = "person_worker";

const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-chief", personId: CHIEF as never, roles: ["Chief"] },
    { token: "tok-worker", personId: WORKER as never, roles: ["Worker"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

interface SendAcceptedWire {
  messageId: string;
  threadId: string;
  sequence: number;
  duplicate?: boolean;
}

interface MessageWire {
  id: string;
  clientMessageId: string;
  senderId: string;
  body: { text: string };
}

function sendBody(text: string, clientMessageId: string): Record<string, unknown> {
  return {
    address: `person:${CHIEF}`,
    body: { text },
    priority: "normal",
    clientMessageId,
  };
}

/** A fresh external worker, authenticated, with the chief's allowlist in place. */
async function connectWorker(port: number): Promise<ExternalChief> {
  const worker = await ExternalChief.connect(port);
  const auth = await worker.authenticate("tok-worker");
  assert.ok(auth.ok, "worker authenticates");
  return worker;
}

/** Provision the chief's contact policy (first contact is deliberate, DEC-14). */
async function chiefAllowlistsWorker(port: number): Promise<ExternalChief> {
  const chief = await ExternalChief.connect(port);
  const auth = await chief.authenticate("tok-chief");
  assert.ok(auth.ok, "chief authenticates");
  const policy = await chief.command("SetContactPolicy", {
    allowlist: [WORKER],
    defaultRule: "deny",
  });
  assert.ok(policy.ok, "contact policy set");
  return chief;
}

function assertSweepHealthy(sweep: SweepReport, label: string): void {
  assert.equal(typeof sweep.found, "number", `${label}: sweep report well-formed`);
  assert.equal(typeof sweep.settled, "number", `${label}: sweep report well-formed`);
  assert.ok(Array.isArray(sweep.failures), `${label}: sweep report well-formed`);
  assert.deepEqual(sweep.failures, [], `${label}: every pending effect re-drove cleanly`);
  assert.equal(
    sweep.settled,
    sweep.found,
    `${label}: every torn acceptance the sweep found was settled`,
  );
}

describe("W2 — crash-retry at the process level (SIGKILL, real journal)", () => {
  it("accept → SIGKILL → restart: sweep runs, message survives, retry returns the ORIGINAL acceptance", async () => {
    let server: SpawnedServer = await spawnStandaloneServer({ authority: AUTHORITY });
    const dataDir = server.dataDir;
    try {
      assert.deepEqual(
        server.sweep,
        { found: 0, settled: 0, failures: [] },
        "fresh journal: startup sweep ran with nothing pending (DEC-21)",
      );

      const chief = await chiefAllowlistsWorker(server.port);
      const worker = await connectWorker(server.port);

      // The send crosses the durability boundary (DEC-09) — SendAccepted.
      const sent = await worker.command("SendMessage", sendBody("w2 durable", "w2-1"));
      assert.ok(sent.ok, "send accepted");
      const accepted = sent.result as SendAcceptedWire;
      assert.ok(accepted.messageId.startsWith("message_"));
      assert.equal(accepted.duplicate, undefined, "first send is not a duplicate");

      // Hard kill immediately after acceptance — no graceful shutdown.
      await server.kill("SIGKILL");

      // Restart on the SAME journal: the sweep runs before connections.
      server = await spawnStandaloneServer({ authority: AUTHORITY, dataDir });
      assertSweepHealthy(server.sweep, "post-crash sweep");

      // The chief had no presence at kill time; if the effects leg was torn
      // the sweep re-drove it — either way the Delivery is honestly
      // non-terminal (R5 no-presence rule: pending, never failed).
      const worker2 = await connectWorker(server.port);

      // Retry: same clientMessageId + same body → the ORIGINAL acceptance.
      const retried = await worker2.command("SendMessage", sendBody("w2 durable", "w2-1"));
      assert.ok(retried.ok, "retry is not an error");
      const duplicate = retried.result as SendAcceptedWire;
      assert.equal(duplicate.duplicate, true, "DEC-13: the retry is a duplicate");
      assert.equal(duplicate.messageId, accepted.messageId, "SAME messageId — no double commit");
      assert.equal(duplicate.threadId, accepted.threadId);
      assert.equal(duplicate.sequence, accepted.sequence, "same sequence — one journal entry");

      // MSG-019: the Message is in the thread history after the crash.
      const history = await worker2.query("GetMessages", { threadId: accepted.threadId });
      assert.ok(history.ok);
      const messages = (history.result as { messages: MessageWire[] }).messages;
      assert.equal(
        messages.filter((message) => message.clientMessageId === "w2-1").length,
        1,
        "exactly one Message exists for the retried command (I1)",
      );
      assert.equal(messages[0]?.body.text, "w2 durable");
      assert.equal(messages[0]?.senderId, WORKER, "I4: sender identity from auth, not payload");

      // Guarantee 6: nothing was erased — the offline chief can pull it.
      const chief2 = await ExternalChief.connect(server.port);
      await chief2.authenticate("tok-chief");
      const inbox = await chief2.query("GetInbox", {});
      assert.ok(inbox.ok);
      const inboxTexts = (inbox.result as { messages: MessageWire[] }).messages.map(
        (message) => message.body.text,
      );
      assert.ok(inboxTexts.includes("w2 durable"), "held/pending messages remain pullable");

      const delivery = await worker2.query("GetDelivery", { messageId: accepted.messageId });
      assert.ok(delivery.ok);
      const states = (delivery.result as { deliveries: { state: string }[] }).deliveries.map(
        (entry) => entry.state,
      );
      assert.deepEqual(states, ["pending"], "no-presence rule: pending, never failed (R5)");

      await chief.close();
      await worker.close();
      await chief2.close();
      await worker2.close();
    } finally {
      await server.stop();
    }
  });

  it("SIGKILL inside the commit→settle window (fault-injected, F4): the sweep provably settles torn acceptances; no double commit", async () => {
    const CLIENT_MESSAGE_IDS = Array.from({ length: 10 }, (_, index) => `w2f-${index}`);
    // F4: the fault-injection hook holds the commit→effects-settle window
    // open for 250 ms per send; killing at 100 ms lands inside the window on
    // EVERY run — the torn-leg assertions below are unconditional.
    const EFFECT_LEG_DELAY_MS = 250;
    const KILL_AFTER_MS = 100;

    let server: SpawnedServer = await spawnStandaloneServer({
      authority: AUTHORITY,
      serverOptions: { effectLegDelayMs: EFFECT_LEG_DELAY_MS },
    });
    const dataDir = server.dataDir;
    try {
      const chief = await chiefAllowlistsWorker(server.port);
      const worker = await connectWorker(server.port);

      // Fire every send WITHOUT awaiting — all in flight at the kill.
      for (const clientMessageId of CLIENT_MESSAGE_IDS) {
        worker.send({
          kind: "command",
          requestId: `fire-${clientMessageId}`,
          name: "SendMessage",
          input: sendBody(`fired ${clientMessageId}`, clientMessageId),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, KILL_AFTER_MS));
      await server.kill("SIGKILL");

      // Restart on the same journal; the startup sweep re-drives the torn leg.
      server = await spawnStandaloneServer({ authority: AUTHORITY, dataDir });
      assertSweepHealthy(server.sweep, "post-crash sweep (kill inside the window)");
      // F4: the torn window was PROVABLY hit — never a vacuous pass.
      assert.ok(
        server.sweep.found > 0,
        "F4: the kill landed inside the commit→settle window — at least one acceptance was torn",
      );
      assert.equal(
        server.sweep.settled,
        server.sweep.found,
        "every torn acceptance the sweep found was settled",
      );

      // Retry every command — each converges to exactly one acceptance.
      const worker2 = await connectWorker(server.port);
      const acceptedByClientMessageId = new Map<string, SendAcceptedWire>();
      for (const clientMessageId of CLIENT_MESSAGE_IDS) {
        const outcome = await worker2.command(
          "SendMessage",
          sendBody(`fired ${clientMessageId}`, clientMessageId),
        );
        assert.ok(outcome.ok, `retry of ${clientMessageId} is not an error`);
        const result = outcome.result as SendAcceptedWire;
        acceptedByClientMessageId.set(clientMessageId, result);
        assert.ok(result.messageId.startsWith("message_"));
      }

      // No double commit: one Message per clientMessageId, no more, no less.
      const threadIds = new Set(
        [...acceptedByClientMessageId.values()].map((result) => result.threadId),
      );
      assert.equal(threadIds.size, 1, "all direct sends share the canonical thread (DEC-03)");
      const history = await worker2.query("GetMessages", {
        threadId: [...threadIds][0] as string,
      });
      assert.ok(history.ok);
      const messages = (history.result as { messages: MessageWire[] }).messages;
      const byClientMessageId = new Map<string, MessageWire[]>();
      for (const message of messages) {
        const bucket = byClientMessageId.get(message.clientMessageId) ?? [];
        bucket.push(message);
        byClientMessageId.set(message.clientMessageId, bucket);
      }
      for (const [clientMessageId, bucket] of byClientMessageId) {
        assert.equal(
          bucket.length,
          1,
          `${clientMessageId}: exactly one Message in history (I1, DEC-13)`,
        );
      }
      for (const [clientMessageId, result] of acceptedByClientMessageId) {
        const stored = byClientMessageId.get(clientMessageId);
        assert.ok(stored !== undefined, `${clientMessageId}: the acceptance is in history`);
        assert.equal(
          stored[0]?.id,
          result.messageId,
          `${clientMessageId}: history and acceptance agree on the messageId`,
        );
      }

      await chief.close();
      await worker2.close();
    } finally {
      await server.stop();
    }
  });
});
