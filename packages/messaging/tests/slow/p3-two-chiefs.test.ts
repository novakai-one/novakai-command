/**
 * P3 proof (Plan §15 P3, MSG-005, MSG-019): two externally spawned Chiefs
 * hold a direct 1-1 conversation over the standalone protocol — both
 * directions — then BOTH disconnect; on reconnection each pulls the full
 * ordered history via GetMessages. Neither principal imports anything
 * Novakai-specific (external-chief speaks the published wire protocol only).
 *
 * What is proven: direct conversation between two external principals works
 * (MSG-005); history is durable across the death of BOTH runtimes
 * (MSG-019/DEC-09 — the journal, not any runtime, owns history); the
 * canonical direct Thread (DEC-03) is the same one both principals read,
 * ordered by journal sequence with sender identity from authentication (I4).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROLE_GRANTS } from "../../contract/index.js";
import type { AuthorityConfig } from "../../contract/index.js";
import { ExternalChief } from "../standalone/external-chief.js";
import { spawnStandaloneServer } from "../standalone/spawned-server.js";

const CHIEF_A = "person_chief-a";
const CHIEF_B = "person_chief-b";

const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-chief-a", personId: CHIEF_A as never, roles: ["Chief"] },
    { token: "tok-chief-b", personId: CHIEF_B as never, roles: ["Chief"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

interface MessageWire {
  id: string;
  clientMessageId: string;
  senderId: string;
  sequence: number;
  body: { text: string };
}

async function connectChief(port: number, token: string): Promise<ExternalChief> {
  const chief = await ExternalChief.connect(port);
  const auth = await chief.authenticate(token);
  assert.ok(auth.ok, `${token} authenticates`);
  return chief;
}

describe("P3 — two external Chiefs converse; history survives both disconnecting", () => {
  it("direct conversation both directions, double disconnect, full ordered history on reconnect", async () => {
    const server = await spawnStandaloneServer({ authority: AUTHORITY });
    try {
      const a = await connectChief(server.port, "tok-chief-a");
      const b = await connectChief(server.port, "tok-chief-b");
      await a.openPresence("chief-a-terminal");
      await b.openPresence("chief-b-terminal");

      // First contact is deliberate on both sides (DEC-14).
      assert.ok(
        (await a.command("SetContactPolicy", { allowlist: [CHIEF_B], defaultRule: "deny" })).ok,
      );
      assert.ok(
        (await b.command("SetContactPolicy", { allowlist: [CHIEF_A], defaultRule: "deny" })).ok,
      );

      // Both subscribe — MSG-023 push on the observation lane, no polling.
      await a.subscribe(["MessageCommitted"]);
      await b.subscribe(["MessageCommitted"]);

      // A → B.
      const hello = await a.command("SendMessage", {
        address: `person:${CHIEF_B}`,
        body: { text: "hello from A" },
        priority: "normal",
        clientMessageId: "p3-a1",
      });
      assert.ok(hello.ok, "A → B accepted");
      const threadId = (hello.result as { threadId: string }).threadId;
      await b.waitForDelivery(
        (message) => (message["body"] as { text: string }).text === "hello from A",
      );

      // B → A (both directions).
      const reply = await b.command("SendMessage", {
        address: `person:${CHIEF_A}`,
        body: { text: "hello from B" },
        priority: "normal",
        clientMessageId: "p3-b1",
      });
      assert.ok(reply.ok, "B → A accepted");
      assert.equal(
        (reply.result as { threadId: string }).threadId,
        threadId,
        "DEC-03: one canonical direct Thread for the pair, both directions",
      );
      await a.waitForDelivery(
        (message) => (message["body"] as { text: string }).text === "hello from B",
      );

      // Each also saw the other's MessageCommitted pushed on the observation lane.
      await a.waitForEvent(
        (event) =>
          ((event["message"] as { body: { text: string } } | undefined)?.body.text) ===
          "hello from B",
      );
      await b.waitForEvent(
        (event) =>
          ((event["message"] as { body: { text: string } } | undefined)?.body.text) ===
          "hello from A",
      );

      // BOTH disconnect — every runtime is gone; the journal owns history.
      await a.close();
      await b.close();

      // Reconnect (fresh sockets, fresh authentication) and pull the full
      // ordered history by typed query (MSG-006) — the catch-up path.
      const a2 = await connectChief(server.port, "tok-chief-a");
      const historyA = await a2.query("GetMessages", { threadId });
      assert.ok(historyA.ok);
      const messagesA = (historyA.result as { messages: MessageWire[] }).messages;
      assert.deepEqual(
        messagesA.map((message) => message.body.text),
        ["hello from A", "hello from B"],
        "MSG-019: the full conversation survives both principals disconnecting",
      );
      assert.deepEqual(
        messagesA.map((message) => message.senderId),
        [CHIEF_A, CHIEF_B],
        "I4: sender identity is the authenticated principal, preserved durably",
      );
      assert.ok(
        messagesA[0] !== undefined &&
          messagesA[1] !== undefined &&
          messagesA[0].sequence < messagesA[1].sequence,
        "DEC-19: history is sequence-ordered",
      );

      // The other principal reads the SAME truth.
      const b2 = await connectChief(server.port, "tok-chief-b");
      const historyB = await b2.query("GetMessages", { threadId });
      assert.ok(historyB.ok);
      assert.deepEqual(
        (historyB.result as { messages: MessageWire[] }).messages.map(
          (message) => message.body.text,
        ),
        ["hello from A", "hello from B"],
        "both principals read one shared history (G9: no competing copies)",
      );

      await a2.close();
      await b2.close();
    } finally {
      await server.stop();
    }
  });
});
