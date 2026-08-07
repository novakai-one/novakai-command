/**
 * P1 proof (Plan §15 P1, G13, MSG-022 — the S3 slice exit condition): a
 * STANDALONE MESSENGER APP as the capability's second host.
 *
 * The app under test is examples/messenger-cli/app.mjs — a separate package
 * with its own package.json (dependency: `ws` only), OUTSIDE the messaging
 * compile graph, run here as a REAL CHILD PROCESS. It:
 *
 *   - provisions identity the way any external host does: it holds only a
 *     bearer token + server URL; the standalone server's authority config is
 *     the v1 provisioning interface (DEC-07 mapping in config, never core);
 *   - speaks ONLY the published DEC-17 JSON-over-WebSocket protocol and
 *     imports NOTHING from the messaging package (asserted by the
 *     architecture suite's examples scan);
 *   - authenticates, opens a Presence, sends 1-1 and to a room, queries
 *     inbox/thread history, subscribes, and RENDERS ITS OWN TEXT UI from
 *     local projections built purely from query results + pushed frames.
 *
 * What is proven here (the P1/G13 core): after a send from another host
 * process, the app's rendered inbox and thread views show the message tagged
 * [pushed] with ZERO GetInbox/GetMessages queries issued (stats) — the UI
 * reflects Messaging state without polling (MSG-023). The explicit sync-*
 * catch-up pull is demonstrated separately on a fresh app instance
 * (projection empty → pull → view shows history tagged [pulled]).
 *
 * Zero messaging core code was changed for this slice; the app needed nothing
 * but the frozen contract and the wire protocol.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROLE_GRANTS } from "../../public/index.js";
import type { AuthorityConfig } from "../../public/index.js";
import { spawnStandaloneServer } from "../standalone/spawned-server.js";

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
const APP_ENTRY = join(packageRoot, "examples", "messenger-cli", "app.mjs");

const ALICE = "person_alice";
const BOB = "person_bob";

const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-alice", personId: ALICE as never, roles: ["Worker"] },
    { token: "tok-bob", personId: BOB as never, roles: ["Worker"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

/** The room truth lives in membership config, never core (Seams §3). */
const MEMBERSHIP = {
  rooms: [
    {
      threadKind: "team",
      authority: "example-org",
      externalId: "room-general",
      members: [ALICE, BOB],
    },
  ],
};

// --- the app driver: speaks JSON-lines to the child process -------------------

interface AppError {
  name: string;
  message: string;
}

type PushSummary = Record<string, unknown>;

interface PushWaiter {
  match: (push: PushSummary) => boolean;
  resolve: (push: PushSummary) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class MessengerApp {
  private constructor(
    private readonly child: ChildProcess,
    readonly personId: string,
  ) {
    // A dead child must reject every outstanding call — a wedged app turns
    // into a loud test failure, never a silent suite hang (audit F2).
    child.once("exit", () => {
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`app process exited with call ${id} outstanding`));
      }
      this.pending.clear();
    });
  }

  private lineBuffer = "";
  private readonly pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private readonly pushBacklog: PushSummary[] = [];
  private readonly pushWaiters: PushWaiter[] = [];
  private commandCounter = 0;

  static async spawn(options: { port: number; token: string; name: string }): Promise<MessengerApp> {
    const child = spawn(
      process.execPath,
      [APP_ENTRY, "--url", `ws://127.0.0.1:${options.port}`, "--token", options.token, "--name", options.name],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // The app's first stdout line is READY <personId> (or FATAL <json>).
    let rest = "";
    const personId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`app did not become READY\nstderr:\n${stderr}`)), 10_000);
      let buffer = "";
      child.stdout?.on("data", function onData(chunk: Buffer) {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const first = buffer.slice(0, newline);
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        // Keep the remainder of the chunk for the steady-state reader.
        rest = buffer.slice(newline + 1);
        if (first.startsWith("READY ")) {
          resolve(first.slice("READY ".length).trim());
        } else {
          reject(new Error(`app failed to start: ${first}\nstderr:\n${stderr}`));
        }
      });
    });

    const app = new MessengerApp(child, personId);
    child.stdout?.on("data", (chunk: Buffer) => app.acceptChunk(chunk.toString("utf8")));
    if (rest !== "") app.acceptChunk(rest);
    return app;
  }

  private acceptChunk(chunk: string): void {
    this.lineBuffer += chunk;
    for (;;) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line !== "") this.acceptLine(line);
    }
  }

  private acceptLine(line: string): void {
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (typeof frame["push"] === "object" && frame["push"] !== null) {
      const push = frame["push"] as PushSummary;
      const index = this.pushWaiters.findIndex((waiter) => waiter.match(push));
      if (index >= 0) {
        const [waiter] = this.pushWaiters.splice(index, 1);
        clearTimeout(waiter?.timer as NodeJS.Timeout);
        waiter?.resolve(push);
      } else {
        this.pushBacklog.push(push);
      }
      return;
    }
    const id = frame["id"];
    const pending = typeof id === "string" ? this.pending.get(id) : undefined;
    if (pending === undefined) return;
    this.pending.delete(id as string);
    if (frame["ok"] === true) {
      pending.resolve(frame["result"]);
    } else {
      const error = frame["error"] as AppError | undefined;
      pending.reject(new Error(`app command failed: ${error?.name ?? "unknown"}: ${error?.message ?? line}`));
    }
  }

  /** Issue one app command and await its correlated response (bounded). */
  call(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    this.commandCounter += 1;
    const id = `c${this.commandCounter}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app command ${cmd} (${id}) did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.child.stdin?.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    return response;
  }

  /** Await a pushed notification matching `match` (backlog first). */
  waitForPush(match: (push: PushSummary) => boolean, timeoutMs = 5_000): Promise<PushSummary> {
    const index = this.pushBacklog.findIndex(match);
    if (index >= 0) {
      const [push] = this.pushBacklog.splice(index, 1);
      return Promise.resolve(push as PushSummary);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pushWaiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.pushWaiters.splice(index, 1);
        reject(new Error("messenger-app driver: timed out waiting for push"));
      }, timeoutMs);
      this.pushWaiters.push({ match, resolve, reject, timer });
    });
  }

  async quit(): Promise<void> {
    if (this.child.exitCode !== null) return;
    try {
      await this.call("quit", {}, 5_000);
    } catch {
      // A wedged app must not take the suite down with it — fall through
      // to the kill path (audit F2).
    }
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    await Promise.race([exited, timeout]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

/** Narrow a call() result to a record, failing loudly otherwise. */
function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "expected an object result");
  return value as Record<string, unknown>;
}

function asStats(value: unknown): { queries: Record<string, number>; pushes: number } {
  const record = asRecord(value);
  return { queries: record["queries"] as Record<string, number>, pushes: record["pushes"] as number };
}

describe("P1 — standalone messenger app as the second host (G13, MSG-022)", () => {
  it("two app processes converse; the rendered UI reflects Messaging state PUSHED, never polled", async () => {
    const server = await spawnStandaloneServer({
      authority: AUTHORITY,
      serverOptions: { membership: MEMBERSHIP },
    });
    let alice: MessengerApp | undefined;
    let bob: MessengerApp | undefined;
    try {
      // Both apps provision identity the external way: token + URL only.
      alice = await MessengerApp.spawn({ port: server.port, token: "tok-alice", name: "alice" });
      bob = await MessengerApp.spawn({ port: server.port, token: "tok-bob", name: "bob" });
      assert.equal(alice.personId, ALICE, "identity learned from the handshake, never asserted");
      assert.equal(bob.personId, BOB);

      // Open presences; first contact is deliberate (DEC-14).
      await alice.call("open-presence");
      await bob.call("open-presence");
      await alice.call("allow", { personId: BOB });
      await bob.call("allow", { personId: ALICE });

      // Alice subscribes: events are PUSHED from here — no polling.
      await alice.call("subscribe", { events: ["MessageCommitted", "PresenceChanged"] });
      await bob.call("subscribe", { events: ["MessageCommitted", "PresenceChanged"] });

      // Startup discovery (as a real messenger would): learn the visible
      // Threads once, so renders can label them. ListThreadsForPerson is not
      // an inbox/message poll — the no-poll assertions below target those.
      await alice.call("list-threads");
      await bob.call("list-threads");

      // --- 1-1 flow: bob sends; alice's UI updates via PUSH. ----------------
      const sent = asRecord(
        await bob.call("send", {
          address: `person:${ALICE}`,
          text: "standup notes are in",
          clientMessageId: "p1-direct-1",
        }),
      );
      assert.ok(typeof sent["messageId"] === "string", "SendAccepted crosses the wire");
      const directThreadId = sent["threadId"] as string;

      const push = await alice.waitForPush(
        (candidate) => candidate["lane"] === "delivery" && candidate["text"] === "standup notes are in",
      );
      assert.equal(push["senderId"], BOB);

      // THE P1 assertion: the rendered inbox shows the message, tagged
      // [pushed], and the app issued ZERO inbox queries to learn of it.
      const inboxView = (await alice.call("render-inbox")) as string;
      assert.match(inboxView, /INBOX for person_alice — 1 message\(s\)/);
      assert.match(inboxView, /\[pushed\] person_bob @ thread_\S+: standup notes are in/);
      const statsAfterPush = asStats(await alice.call("stats"));
      assert.equal(statsAfterPush.queries["GetInbox"] ?? 0, 0, "the inbox view needed no poll (MSG-023)");
      assert.ok(statsAfterPush.pushes >= 1);

      // The thread view renders from the same pushed projection.
      const threadView = (await alice.call("render-thread", { threadId: directThreadId })) as string;
      assert.match(threadView, /\[pushed\] person_bob: standup notes are in/);

      // --- room flow: alice discovers the room and posts; bob is pushed. -----
      const threads = (await alice.call("list-threads")) as { id: string; kind: string }[];
      const room = threads.find((thread) => thread.kind === "team");
      assert.ok(room !== undefined, "the room Thread is visible via ListThreadsForPerson");

      const roomSend = asRecord(
        await alice.call("send", {
          address: `thread:${room.id}`,
          text: "room announcement: freeze on friday",
          clientMessageId: "p1-room-1",
        }),
      );
      assert.ok(typeof roomSend["messageId"] === "string");

      await bob.waitForPush(
        (candidate) => candidate["lane"] === "delivery" && candidate["text"] === "room announcement: freeze on friday",
      );
      const bobInbox = (await bob.call("render-inbox")) as string;
      assert.match(bobInbox, /\[pushed\] person_alice @ thread_\S+: room announcement: freeze on friday/);
      const bobRoomView = (await bob.call("render-thread", { threadId: room.id })) as string;
      assert.match(bobRoomView, /THREAD thread_\S+ \(team\) — 1 message\(s\)/);
      assert.match(bobRoomView, /\[pushed\] person_alice: room announcement: freeze on friday/);
      const bobStats = asStats(await bob.call("stats"));
      assert.equal(bobStats.queries["GetInbox"] ?? 0, 0);
      assert.equal(bobStats.queries["GetMessages"] ?? 0, 0, "the room view needed no poll either");

      // --- presence line from published projections (pushed observations). ---
      const presenceView = (await bob.call("render-presence")) as string;
      assert.match(presenceView, /person_alice: online \(1 presence\) \[pushed\]/);

      // Alice quits → her presence closes → bob's presence line flips offline
      // via a PUSHED PresenceChanged observation (R11), again with no poll.
      const offlinePush = bob.waitForPush(
        (candidate) => candidate["event"] === "PresenceChanged" && candidate["personId"] === ALICE && candidate["change"] === "closed",
      );
      await alice.quit();
      await offlinePush;
      const afterQuit = (await bob.call("render-presence")) as string;
      assert.match(afterQuit, /person_alice: offline \[pushed\]/);
      alice = undefined; // already quit

      await bob.quit();
      bob = undefined;
    } finally {
      await alice?.quit();
      await bob?.quit();
      await server.stop();
    }
  });

  it("catch-up pull: a fresh app instance renders history [pulled] from queries (the reconnect fallback)", async () => {
    const server = await spawnStandaloneServer({
      authority: AUTHORITY,
      serverOptions: { membership: MEMBERSHIP },
    });
    let alice: MessengerApp | undefined;
    let bob: MessengerApp | undefined;
    try {
      // Seed history: bob online, alice sends a 1-1, bob pulls nothing yet.
      alice = await MessengerApp.spawn({ port: server.port, token: "tok-alice", name: "alice" });
      bob = await MessengerApp.spawn({ port: server.port, token: "tok-bob", name: "bob" });
      await alice.call("open-presence");
      await alice.call("allow", { personId: BOB });
      await bob.call("allow", { personId: ALICE });
      const sent = asRecord(
        await alice.call("send", {
          address: `person:${BOB}`,
          text: "durable while you were away",
          clientMessageId: "p1-catchup-1",
        }),
      );
      const threadId = sent["threadId"] as string;
      await alice.quit();
      alice = undefined;
      await bob.quit();
      bob = undefined;

      // A FRESH app instance (empty projections — a restart, a new machine)
      // catches up by explicit pull: sync-inbox + sync-thread, then renders.
      const bob2 = await MessengerApp.spawn({ port: server.port, token: "tok-bob", name: "bob-returned" });
      bob = bob2;
      const emptyInbox = (await bob2.call("render-inbox")) as string;
      assert.match(emptyInbox, /INBOX for person_bob — 0 message\(s\)/, "fresh projection knows nothing");

      await bob2.call("sync-inbox");
      await bob2.call("sync-thread", { threadId });
      const inboxView = (await bob2.call("render-inbox")) as string;
      assert.match(inboxView, /\[pulled\] person_alice @ thread_\S+: durable while you were away/);
      const threadView = (await bob2.call("render-thread", { threadId })) as string;
      assert.match(threadView, /\[pulled\] person_alice: durable while you were away/);
      const stats = asStats(await bob2.call("stats"));
      assert.equal(stats.queries["GetInbox"], 1, "exactly the explicit catch-up pull");
      assert.equal(stats.pushes, 0, "no subscription — this leg is pull-only by design");

      await bob2.quit();
      bob = undefined;
    } finally {
      await alice?.quit();
      await bob?.quit();
      await server.stop();
    }
  });
});
