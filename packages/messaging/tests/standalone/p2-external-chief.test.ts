/**
 * P2 proof (Plan §15 P2, MSG-004, MSG-023): an external terminal-spawned
 * Chief — no Novakai Command running, no Novakai-specific object in hand —
 * provisions identity, authenticates over the standalone protocol, and
 * exchanges Messages with another external principal, receiving PUSHED
 * events without polling.
 *
 * Provisioning (documented): identity lives with the Identity authority,
 * which for the standalone deployment is the authority CONFIG the server is
 * started with (DEC-07: role→grant mapping in config, never core). An
 * operator issues the Chief a Person ID + bearer token out of band; the
 * Chief needs nothing Novakai-specific beyond the published wire protocol —
 * the client here (tests/standalone/external-chief.ts) imports no messaging
 * code at runtime (asserted by the architecture suite).
 *
 * What is proven: connect → pre-auth discovery → authenticate → OpenPresence
 * → Subscribe → a message arrives PUSHED on both lanes (the addressed
 * delivery frame AND the observation-lane MessageCommitted event) without a
 * single poll, and the sender sees the Delivery settle delivered (a real
 * socket effect, DEC-08).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROLE_GRANTS } from "../../public/index.js";
import type { AuthorityConfig } from "../../public/index.js";
import { ExternalChief } from "./external-chief.js";
import { spawnStandaloneServer } from "./spawned-server.js";

const CHIEF = "person_chief";
const WORKER = "person_worker";

const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-chief", personId: CHIEF as never, roles: ["Chief"] },
    { token: "tok-worker", personId: WORKER as never, roles: ["Worker"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

describe("P2 — external Chief over the published wire protocol (MSG-004, MSG-023)", () => {
  it("provision, authenticate, presence, pushed delivery + event — no Novakai object, no polling", async () => {
    const server = await spawnStandaloneServer({ authority: AUTHORITY });
    try {
      // Provisioned out of band: the operator's authority config maps
      // tok-chief → person_chief (+ Chief role grants). The Chief connects
      // with nothing but the protocol and the token.
      const chief = await ExternalChief.connect(server.port);

      // Pre-authentication discovery (R3): versions + limits only.
      const capabilities = await chief.getCapabilities();
      assert.equal(capabilities["protocolVersion"], "1.0.0");
      assert.equal(capabilities["contractVersion"], "1.1.0"); // A-R-N4-1 (oversight.read)
      assert.ok((capabilities["features"] as string[]).includes("subscribe"));
      assert.deepEqual(capabilities["limits"], {
        messageMaxBytes: 32768,
        pageLimitMax: 200,
        subscriptionBufferMax: 256,
      });

      // Authenticate: principal identity derives from the credential (I4).
      const auth = await chief.authenticate("tok-chief");
      assert.ok(auth.ok, "handshake accepted");
      const principal = auth.result as { personId: string; grants: string[] };
      assert.equal(principal.personId, CHIEF);
      assert.ok(principal.grants.includes("priority.override"), "Chief role grants (DEC-07)");

      // Explicit OpenPresence (R9: auth alone never registers a Presence).
      const presenceId = await chief.openPresence();
      assert.ok(presenceId.startsWith("presence_"));

      // First contact is deliberate (DEC-14): allowlist the worker.
      const policy = await chief.command("SetContactPolicy", {
        allowlist: [WORKER],
        defaultRule: "deny",
      });
      assert.ok(policy.ok, "contact policy set");

      // Subscribe: the stream itself acknowledges (started). Events are
      // PUSHED from here — the Chief issues no queries to learn of messages.
      const subscriptionId = await chief.subscribe(["MessageCommitted"]);
      assert.ok(subscriptionId.startsWith("subscription_"));

      // A second external principal (a worker agent) sends the Chief a message.
      const worker = await ExternalChief.connect(server.port);
      assert.ok((await worker.authenticate("tok-worker")).ok);
      await worker.openPresence();
      const sent = await worker.command("SendMessage", {
        address: `person:${CHIEF}`,
        body: { text: "mission report ready" },
        priority: "normal",
        clientMessageId: "p2-1",
      });
      assert.ok(sent.ok, "send accepted");
      const accepted = sent.result as { messageId: string; threadId: string; sequence: number };

      // MSG-023: the Chief is PUSHED TO on both lanes — no poll was issued.
      const delivery = await chief.waitForDelivery(
        (message) => (message["body"] as { text: string }).text === "mission report ready",
      );
      assert.equal((delivery["message"] as { id: string }).id, accepted.messageId);
      assert.equal(delivery["presenceId"], presenceId, "the effect landed on the Chief's Presence");
      const pushed = await chief.waitForEvent(
        (event) => ((event["message"] as { id: string } | undefined)?.id) === accepted.messageId,
      );
      assert.equal(pushed["subscriptionId"], subscriptionId);
      assert.equal(pushed["sequence"], accepted.sequence, "journal sequence crosses verbatim");

      // DEC-08 over the wire: the sender observes delivered — a REAL socket
      // effect, not a journal write (G10).
      const deliveryState = await worker.query("GetDelivery", { messageId: accepted.messageId });
      assert.ok(deliveryState.ok);
      const states = (deliveryState.result as { deliveries: { state: string }[] }).deliveries.map(
        (entry) => entry.state,
      );
      assert.deepEqual(states, ["delivered"]);

      await chief.close();
      await worker.close();
    } finally {
      await server.stop();
    }
  });

  it("honest refusals over the wire: unknown token, wrong protocol version, spoofed sender", async () => {
    const server = await spawnStandaloneServer({ authority: AUTHORITY });
    try {
      const stranger = await ExternalChief.connect(server.port);
      const badToken = await stranger.authenticate("tok-nobody");
      assert.ok(!badToken.ok);
      assert.equal(badToken.ok ? undefined : badToken.error.name, "NotAuthenticated");

      const wrongVersion = await stranger.authenticate("tok-chief", "0.0.1");
      assert.ok(!wrongVersion.ok);
      assert.equal(wrongVersion.ok ? undefined : wrongVersion.error.name, "VersionUnsupported");

      const chief = await ExternalChief.connect(server.port);
      assert.ok((await chief.authenticate("tok-chief")).ok);

      // MSG-020/G3: a caller-supplied sender field is a schema violation at
      // the door — identity comes from authentication, never the payload.
      const spoof = await chief.command("SendMessage", {
        address: `person:${WORKER}`,
        from: WORKER,
        body: { text: "trust me" },
        priority: "normal",
        clientMessageId: "p2-spoof",
      });
      assert.ok(!spoof.ok);
      assert.equal(spoof.ok ? undefined : spoof.error.name, "ValidationFailed");

      // First contact without an allowlist is a typed refusal (DEC-14).
      const worker = await ExternalChief.connect(server.port);
      assert.ok((await worker.authenticate("tok-worker")).ok);
      const blocked = await worker.command("SendMessage", {
        address: `person:${CHIEF}`,
        body: { text: "unsolicited" },
        priority: "normal",
        clientMessageId: "p2-blocked",
      });
      assert.ok(!blocked.ok);
      assert.equal(blocked.ok ? undefined : blocked.error.name, "BlockedByContactPolicy");

      await stranger.close();
      await chief.close();
      await worker.close();
    } finally {
      await server.stop();
    }
  });
});
