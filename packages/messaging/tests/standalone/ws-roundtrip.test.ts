/**
 * Standalone WS round-trip over REAL localhost sockets (DEC-17 end-to-end):
 * the P2/P3 mechanics — an external principal authenticates over the
 * protocol, opens a Presence, is PUSHED TO (MSG-023: delivery lane +
 * subscription stream, never polling), disconnects, and closes the gap by
 * cursor replay (W4). Two simultaneous external principals converse (P3
 * shape); history survives both disconnecting (store-jsonl).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  createStandaloneMessaging,
  cursorFor,
  DEFAULT_ROLE_GRANTS,
} from "../../contract/index.js";
import type { StandaloneMessaging } from "../../contract/index.js";

const CHIEF = "person_chief";
const WORKER = "person_worker";

// --- a minimal DEC-17 client (the external Chief's view of the wire) --------------

type Frame = Record<string, unknown>;

class TestClient {
  private socket: WebSocket;
  private backlog: Frame[] = [];
  private waiters: {
    match: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8")) as Frame;
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.match(frame));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter?.timer as NodeJS.Timeout);
        waiter?.resolve(frame);
      } else {
        this.backlog.push(frame);
      }
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
    return new TestClient(socket);
  }

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Send raw bytes (malformed-frame tests). */
  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  /** Await the next frame matching `match` (backlog first; matched frames are consumed). */
  waitFor(match: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
    const index = this.backlog.findIndex(match);
    if (index >= 0) {
      const [frame] = this.backlog.splice(index, 1);
      return Promise.resolve(frame as Frame);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error("timed out waiting for frame"));
      }, timeoutMs);
      this.waiters.push({ match, resolve, reject, timer });
    });
  }

  /** Send a request frame and await ANY correlated response (result or error). */
  async request(frame: Frame): Promise<Frame> {
    const requestId = frame["requestId"];
    this.send(frame);
    return this.waitFor((candidate) => candidate["requestId"] === requestId);
  }

  async authenticate(token: string): Promise<Frame> {
    const response = await this.request({
      kind: "authenticate",
      requestId: `auth-${token}`,
      credential: { token },
    });
    assert.equal(response["kind"], "authenticated", `authenticate ${token}`);
    return response;
  }

  async openPresence(): Promise<string> {
    const response = await this.request({
      kind: "command",
      requestId: "open-1",
      name: "OpenPresence",
      input: { transport: "ws", clientLabel: "test-client" },
    });
    assert.equal(response["kind"], "command-result", JSON.stringify(response));
    return (response["result"] as { presenceId: string }).presenceId;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const done = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.close();
    await done;
  }
}

// --- server fixture ------------------------------------------------------------------

let server: StandaloneMessaging | undefined;
let dataDir: string | undefined;

async function startServer(): Promise<StandaloneMessaging> {
  dataDir = mkdtempSync(join(tmpdir(), "messaging-ws-test-"));
  server = await createStandaloneMessaging({
    dataPath: join(dataDir, "messaging.jsonl"),
    port: 0,
    authority: {
      principals: [
        { token: "tok-chief", personId: CHIEF as never, roles: ["Chief"] },
        { token: "tok-worker", personId: WORKER as never, roles: ["Worker"] },
        { token: "tok-admin", personId: "person_admin" as never, grants: ["template.write"] },
      ],
      roleGrants: DEFAULT_ROLE_GRANTS,
    },
  });
  return server;
}

async function stopServer(): Promise<void> {
  await server?.close();
  server = undefined;
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
}

async function command(client: TestClient, requestId: string, name: string, input: unknown): Promise<Frame> {
  return client.request({ kind: "command", requestId, name, input });
}

describe("standalone WS round-trip (DEC-17, real sockets)", () => {
  it("P2 mechanics: auth handshake, presence, pushed delivery + subscription event, honest errors", async () => {
    const srv = await startServer();
    try {
      assert.deepEqual(srv.sweep, { found: 0, settled: 0, failures: [] }, "startup sweep ran (DEC-21)");

      // Pre-authentication discovery (R3).
      const chief = await TestClient.connect(srv.port);
      chief.send({ kind: "get-capabilities" });
      const caps = await chief.waitFor((frame) => frame["kind"] === "capabilities");
      const capabilities = caps["capabilities"] as { features: string[]; protocolVersion: string };
      assert.equal(capabilities.protocolVersion, "1.0.0");
      assert.ok(capabilities.features.includes("subscribe"));

      // Command before auth → NotAuthenticated error frame, connection stays up.
      const early = await command(chief, "early-1", "SendMessage", {
        address: `person:${WORKER}`,
        body: { text: "too early" },
        priority: "normal",
        clientMessageId: "ws-early",
      });
      assert.equal(early["kind"], "error");
      assert.equal((early["error"] as { name: string }).name, "NotAuthenticated");

      await chief.authenticate("tok-chief");
      await chief.openPresence();

      // Subscribe (MessageCommitted) — the stream itself acknowledges (started).
      chief.send({
        kind: "subscribe",
        requestId: "sub-1",
        input: { events: ["MessageCommitted"] },
      });
      const started = await chief.waitFor(
        (frame) => frame["kind"] === "started" && typeof frame["subscriptionId"] === "string",
      );
      assert.ok((started["subscriptionId"] as string).startsWith("subscription_"));

      const worker = await TestClient.connect(srv.port);
      await worker.authenticate("tok-worker");
      await worker.openPresence();

      // Contact policy is honest over the wire: default-deny blocks first contact (DEC-14).
      const blocked = await command(worker, "send-blocked", "SendMessage", {
        address: `person:${CHIEF}`,
        body: { text: "unsolicited" },
        priority: "normal",
        clientMessageId: "ws-b0",
      });
      assert.equal(blocked["kind"], "error");
      assert.equal((blocked["error"] as { name: string }).name, "BlockedByContactPolicy");

      // Deliberate first contact: the chief allowlists the worker.
      const policy = await command(chief, "policy-1", "SetContactPolicy", {
        allowlist: [WORKER],
        defaultRule: "deny",
      });
      assert.equal(policy["kind"], "command-result");

      // The send is accepted…
      const sent = await command(worker, "send-1", "SendMessage", {
        address: `person:${CHIEF}`,
        body: { text: "report ready" },
        priority: "normal",
        clientMessageId: "ws-1",
      });
      assert.equal(sent["kind"], "command-result", JSON.stringify(sent));
      const accepted = sent["result"] as { messageId: string; sequence: number };

      // …and the chief is PUSHED TO on both lanes (MSG-023): the addressed
      // delivery frame AND the observation-lane subscription event.
      const delivery = await chief.waitFor((frame) => frame["kind"] === "delivery");
      assert.equal(((delivery["message"] as { body: { text: string } }).body.text), "report ready");
      const pushed = await chief.waitFor(
        (frame) => frame["kind"] === "event" && frame["sequence"] === accepted.sequence,
      );
      assert.equal(
        ((pushed["event"] as { message: { id: string } }).message.id),
        accepted.messageId,
      );

      // DEC-08 honesty over the wire: the Delivery settled delivered (real socket effect).
      const deliveryState = await worker.request({
        kind: "query",
        requestId: "gd-1",
        name: "GetDelivery",
        input: { messageId: accepted.messageId },
      });
      const deliveries = (deliveryState["result"] as { deliveries: { state: string }[] }).deliveries;
      assert.equal(deliveries[0]?.state, "delivered");

      await chief.close();
      await worker.close();
    } finally {
      await stopServer();
    }
  });

  it("malformed input over the wire → typed error frames, connection survives (MSG-021)", async () => {
    const srv = await startServer();
    try {
      const client = await TestClient.connect(srv.port);

      client.sendRaw("this is not json{");
      const notJson = await client.waitFor((frame) => frame["kind"] === "error");
      assert.equal((notJson["error"] as { name: string }).name, "ValidationFailed");

      const badKind = await client.request({ kind: "teleport", requestId: "bad-1" });
      assert.equal((badKind["error"] as { name: string }).name, "ValidationFailed");
      assert.equal(badKind["requestId"], "bad-1", "error stays correlated");

      const badToken = await client.request({
        kind: "authenticate",
        requestId: "bad-2",
        credential: { token: "wrong" },
      });
      assert.equal((badToken["error"] as { name: string }).name, "NotAuthenticated");

      const badVersion = await client.request({
        kind: "authenticate",
        requestId: "bad-3",
        credential: { token: "tok-chief" },
        protocolVersion: "0.0.1",
      });
      assert.equal((badVersion["error"] as { name: string }).name, "VersionUnsupported");

      // Still alive and functional after every malformed frame.
      await client.authenticate("tok-chief");
      await client.close();
    } finally {
      await stopServer();
    }
  });

  it("W4 replay leg: disconnect, miss events, reconnect with cursor — exactly-once replay, then live", async () => {
    const srv = await startServer();
    try {
      const worker = await TestClient.connect(srv.port);
      await worker.authenticate("tok-worker");
      await worker.openPresence();

      let chief = await TestClient.connect(srv.port);
      await chief.authenticate("tok-chief");
      await chief.openPresence();
      await command(chief, "policy-r", "SetContactPolicy", { allowlist: [WORKER], defaultRule: "deny" });

      chief.send({ kind: "subscribe", requestId: "sub-r1", input: { events: ["MessageCommitted"] } });
      await chief.waitFor((frame) => frame["kind"] === "started");

      const m1 = await command(worker, "wr-1", "SendMessage", {
        address: `person:${CHIEF}`,
        body: { text: "one" },
        priority: "normal",
        clientMessageId: "wr-1",
      });
      const m1Sequence = (m1["result"] as { sequence: number }).sequence;
      await chief.waitFor((frame) => frame["kind"] === "event" && frame["sequence"] === m1Sequence);

      // The socket dies — presence closes (R9 single close path), the
      // subscription ends best-effort; the journal keeps the facts.
      await chief.close();
      const missed: number[] = [];
      for (const [index, text] of ["two", "three"].entries()) {
        const missed_send = await command(worker, `wr-${index + 2}`, "SendMessage", {
          address: `person:${CHIEF}`,
          body: { text },
          priority: "normal",
          clientMessageId: `wr-${index + 2}`,
        });
        missed.push((missed_send["result"] as { sequence: number }).sequence);
      }

      // Reconnect: replay from the last cursor closes the gap — no polling.
      chief = await TestClient.connect(srv.port);
      await chief.authenticate("tok-chief");
      await chief.openPresence();
      chief.send({
        kind: "subscribe",
        requestId: "sub-r2",
        input: { events: ["MessageCommitted"], since: cursorFor(m1Sequence as never) },
      });
      const restarted = await chief.waitFor((frame) => frame["kind"] === "started");
      assert.equal(restarted["replayedFrom"], cursorFor(m1Sequence as never));

      const replayed: number[] = [];
      for (let index = 0; index < missed.length; index += 1) {
        const frame = await chief.waitFor((candidate) => candidate["kind"] === "event");
        replayed.push(frame["sequence"] as number);
      }
      assert.deepEqual(replayed, missed, "exactly the missed events, in order, once each");

      // Live tail resumes immediately after the replay.
      const m4 = await command(worker, "wr-4", "SendMessage", {
        address: `person:${CHIEF}`,
        body: { text: "four" },
        priority: "normal",
        clientMessageId: "wr-4",
      });
      const live = await chief.waitFor((frame) => frame["kind"] === "event" && frame["sequence"] === (m4["result"] as { sequence: number }).sequence);
      assert.ok(live !== undefined);

      await chief.close();
      await worker.close();
    } finally {
      await stopServer();
    }
  });

  it("P3 shape: two external principals converse; history survives both disconnecting", async () => {
    const srv = await startServer();
    try {
      const chief = await TestClient.connect(srv.port);
      const worker = await TestClient.connect(srv.port);
      await chief.authenticate("tok-chief");
      await worker.authenticate("tok-worker");
      await chief.openPresence();
      await worker.openPresence();
      await command(chief, "p3-cp", "SetContactPolicy", { allowlist: [WORKER], defaultRule: "deny" });
      await command(worker, "p3-wp", "SetContactPolicy", { allowlist: [CHIEF], defaultRule: "deny" });

      chief.send({ kind: "subscribe", requestId: "p3-sub-c", input: { events: ["MessageCommitted"] } });
      worker.send({ kind: "subscribe", requestId: "p3-sub-w", input: { events: ["MessageCommitted"] } });
      await chief.waitFor((frame) => frame["kind"] === "started");
      await worker.waitFor((frame) => frame["kind"] === "started");

      // worker → chief "ping"
      const ping = await command(worker, "p3-ping", "SendMessage", {
        address: `person:${CHIEF}`,
        body: { text: "ping" },
        priority: "normal",
        clientMessageId: "p3-1",
      });
      const threadId = (ping["result"] as { threadId: string }).threadId;
      await chief.waitFor(
        (frame) => frame["kind"] === "delivery" && (frame["message"] as { body: { text: string } }).body.text === "ping",
      );
      // chief → worker "pong"
      await command(chief, "p3-pong", "SendMessage", {
        address: `person:${WORKER}`,
        body: { text: "pong" },
        priority: "normal",
        clientMessageId: "p3-2",
      });
      await worker.waitFor(
        (frame) => frame["kind"] === "delivery" && (frame["message"] as { body: { text: string } }).body.text === "pong",
      );
      // Each saw the other's MessageCommitted on the observation lane too.
      await chief.waitFor(
        (frame) => frame["kind"] === "event" && ((frame["event"] as { message: { body: { text: string } } }).message.body.text === "ping"),
      );
      await worker.waitFor(
        (frame) => frame["kind"] === "event" && ((frame["event"] as { message: { body: { text: string } } }).message.body.text === "pong"),
      );

      // Both disconnect — history is durable (store-jsonl, DEC-09).
      await chief.close();
      await worker.close();

      const chief2 = await TestClient.connect(srv.port);
      await chief2.authenticate("tok-chief");
      const history = await chief2.request({
        kind: "query",
        requestId: "p3-hist",
        name: "GetMessages",
        input: { threadId },
      });
      const texts = ((history["result"] as { messages: { body: { text: string } }[] }).messages).map(
        (message) => message.body.text,
      );
      assert.deepEqual(texts, ["ping", "pong"], "MSG-019: the conversation survives both principals");

      await chief2.close();
    } finally {
      await stopServer();
    }
  });

  it("S4 templates over the wire: UpsertTemplate, SendFromTemplate (pushed render), ListTemplates, RetireTemplate → TemplateNotFound", async () => {
    const srv = await startServer();
    try {
      const admin = await TestClient.connect(srv.port);
      const chief = await TestClient.connect(srv.port);
      const worker = await TestClient.connect(srv.port);
      await admin.authenticate("tok-admin");
      await chief.authenticate("tok-chief");
      await worker.authenticate("tok-worker");
      await chief.openPresence();
      await command(chief, "tpl-cp", "SetContactPolicy", { allowlist: [WORKER], defaultRule: "deny" });

      // template.write is enforced over the wire: a Worker cannot upsert.
      const denied = await command(worker, "tpl-denied", "UpsertTemplate", {
        name: "nope",
        bindings: [{ field: "text", path: "body.text" }],
      });
      assert.equal((denied["error"] as { name: string }).name, "NotAuthorized");

      const created = await command(admin, "tpl-create", "UpsertTemplate", {
        name: "wire-report",
        bindings: [
          { field: "text", path: "body.text" },
          { field: "ticket", path: "body.fields.ticket" },
        ],
      });
      assert.equal(created["kind"], "command-result", JSON.stringify(created));
      const templateId = (created["result"] as { templateId: string }).templateId;

      // The rendered send crosses the same door; the chief is pushed the
      // RENDERED message with its TemplateRef (DEC-15).
      const sent = await command(worker, "tpl-send", "SendFromTemplate", {
        address: `person:${CHIEF}`,
        templateId,
        fields: { text: "rendered over the wire", ticket: "S4" },
        priority: "normal",
        clientMessageId: "tpl-ws-1",
      });
      assert.equal(sent["kind"], "command-result", JSON.stringify(sent));
      const delivery = await chief.waitFor((frame) => frame["kind"] === "delivery");
      const pushedMessage = delivery["message"] as {
        body: { text: string; fields?: Record<string, unknown> };
        template?: { templateId: string };
      };
      assert.equal(pushedMessage.body.text, "rendered over the wire");
      assert.deepEqual(pushedMessage.body.fields, { ticket: "S4" });
      assert.equal(pushedMessage.template?.templateId, templateId);

      // ListTemplates over the wire (any authenticated principal).
      const listed = await worker.request({
        kind: "query",
        requestId: "tpl-list",
        name: "ListTemplates",
        input: {},
      });
      const templates = (listed["result"] as { templates: { id: string; name: string }[] }).templates;
      assert.deepEqual(templates.map((template) => template.name), ["wire-report"]);

      // Retire → new sends fail with the typed error frame; history stands.
      await command(admin, "tpl-retire", "RetireTemplate", { templateId });
      const retired = await command(worker, "tpl-send-2", "SendFromTemplate", {
        address: `person:${CHIEF}`,
        templateId,
        fields: { text: "too late", ticket: "S4" },
        priority: "normal",
        clientMessageId: "tpl-ws-2",
      });
      assert.equal((retired["error"] as { name: string }).name, "TemplateNotFound");

      await admin.close();
      await chief.close();
      await worker.close();
    } finally {
      await stopServer();
    }
  });
});
