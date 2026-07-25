/**
 * S2 standalone proof: room sends ride the DEC-17 WS protocol UNCHANGED (the
 * door is generic) — a spawned standalone server (store-jsonl, real process)
 * with a membership config provisions the room Threads at startup
 * (Store-Seam §11.4), an external member discovers the room via the new
 * ListThreadsForPerson wire query, posts by thread: ID through SendMessage,
 * and a connected member is PUSHED the delivery (addressed lane, MSG-023).
 * The non-member's send and read fail with typed NotAuthorized. Everything
 * crosses the published wire protocol only — the P4 mechanics (a second
 * capability provisioning a room and posting by ID) are proven ready here
 * short of the external Mission Rooms capability itself (S2-b).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AuthorityConfig, MembershipConfig } from "../../public/index.js";
import { DEFAULT_ROLE_GRANTS } from "../../public/index.js";
import { spawnStandaloneServer } from "./spawned-server.js";
import { ExternalChief } from "./external-chief.js";

const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-alice", personId: "person_alice" as never, roles: ["Worker"] },
    { token: "tok-bob", personId: "person_bob" as never, roles: ["Worker"] },
    { token: "tok-admin", personId: "person_admin" as never, grants: ["policy.admin"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

const MEMBERSHIP: MembershipConfig = {
  rooms: [
    {
      threadKind: "mission",
      authority: "mission-capability",
      externalId: "mission-1",
      members: ["person_alice" as never, "person_bob" as never],
    },
  ],
};

describe("S2 standalone — rooms over the DEC-17 wire protocol", () => {
  it("a member discovers the provisioned room, posts by thread: ID, and the connected member is pushed the delivery; non-member is refused", async () => {
    const server = await spawnStandaloneServer({
      authority: AUTHORITY,
      serverOptions: { membership: MEMBERSHIP },
    });
    const alice = await ExternalChief.connect(server.port);
    const bob = await ExternalChief.connect(server.port);
    const admin = await ExternalChief.connect(server.port);
    try {
      assert.equal((await alice.authenticate("tok-alice")).ok, true);
      assert.equal((await bob.authenticate("tok-bob")).ok, true);
      assert.equal((await admin.authenticate("tok-admin")).ok, true);

      // The capability advertises rooms (S2 feature) over the wire.
      const capabilities = await alice.getCapabilities();
      assert.ok((capabilities["features"] as string[]).includes("rooms"));

      // Bob connects his delivery lane and allowlists alice (DEC-14).
      await bob.openPresence();
      const policy = await bob.command("SetContactPolicy", {
        allowlist: ["person_alice"],
        defaultRule: "deny",
      });
      assert.ok(policy.ok, `SetContactPolicy failed: ${policy.ok === false && policy.error.message}`);

      // Discovery through the new wire query: the member sees the mission room.
      const listed = await alice.query("ListThreadsForPerson", {});
      assert.ok(listed.ok, `ListThreadsForPerson failed: ${listed.ok === false && listed.error.message}`);
      if (!listed.ok) return;
      const threads = (listed.result as { threads: { id: string; threadKind: string }[] }).threads;
      const room = threads.find((thread) => thread.threadKind === "mission");
      assert.ok(room, "the mission room Thread was provisioned at startup (§11.4)");

      // The non-member's listing does NOT include the room; send + read refuse.
      const adminListed = await admin.query("ListThreadsForPerson", {});
      assert.ok(adminListed.ok);
      if (adminListed.ok) {
        assert.equal((adminListed.result as { threads: unknown[] }).threads.length, 0);
      }
      const deniedSend = await admin.command("SendMessage", {
        address: `thread:${room.id}`,
        body: { text: "intruder" },
        priority: "normal",
        clientMessageId: "ws-room-0",
      });
      assert.equal(deniedSend.ok, false);
      if (!deniedSend.ok) assert.equal(deniedSend.error.name, "NotAuthorized");
      const deniedRead = await admin.query("GetThread", { threadId: room.id });
      assert.equal(deniedRead.ok, false);
      if (!deniedRead.ok) assert.equal(deniedRead.error.name, "NotAuthorized");

      // The member posts by thread: ID — SendMessage unchanged on the wire.
      const deliveryWait = bob.waitForDelivery(
        (message) => message["threadId"] === room.id,
      );
      const sent = await alice.command("SendMessage", {
        address: `thread:${room.id}`,
        body: { text: "mission room over the wire" },
        priority: "normal",
        clientMessageId: "ws-room-1",
      });
      assert.ok(sent.ok, `room send failed: ${sent.ok === false && sent.error.message}`);
      if (!sent.ok) return;
      const accepted = sent.result as { messageId: string; threadId: string };
      assert.equal(accepted.threadId, room.id);

      // MSG-023: the connected member is PUSHED the delivery — never polled.
      const pushed = await deliveryWait;
      assert.equal((pushed["message"] as { body: { text: string } }).body.text, "mission room over the wire");

      // Both members read the shared history; one Message, one Thread (DEC-05).
      const history = await bob.query("GetMessages", { threadId: room.id });
      assert.ok(history.ok);
      if (history.ok) {
        assert.equal((history.result as { messages: unknown[] }).messages.length, 1);
      }
    } finally {
      await alice.close();
      await bob.close();
      await admin.close();
      await server.stop();
    }
  });
});
