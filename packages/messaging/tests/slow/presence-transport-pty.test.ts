/**
 * PTY presence-transport adapter tests (Messaging-Seams §4.3 obligations):
 * the full §4.1 contract against fake children, plus a real-`cat` smoke test
 * proving the dependency-free spawn + stdin-write shape against an actual
 * process. The shared §4.1 suite (transport-contract.test.ts) covers the
 * adapter-uniform obligations; this file covers PTY-specific mechanics:
 * bind windows, process liveness (exit → onDisconnect, signal-0 probe →
 * onLivenessTimeout), the bounded effect deadline, and bind/open ownership.
 */

import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { schemaVersion } from "../../contract/index.js";
import type { Message, PresenceId, SubscriptionMessage } from "../../contract/index.js";
import type { TransportLivenessCallbacks } from "../../contract/ports/presence-transport.js";
import { createPtyPresenceTransport } from "../../adapters/presence-transport-pty.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import { FakePtyChild } from "../adapters/fakePtyChild.js";

const clock = createSeededClock({ seed: "pty" });

function presenceId(label: string): PresenceId {
  return `presence_${label}` as PresenceId;
}

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

function livenessRecorder(): TransportLivenessCallbacks & { disconnected: PresenceId[]; timedOut: PresenceId[] } {
  const disconnected: PresenceId[] = [];
  const timedOut: PresenceId[] = [];
  return {
    disconnected,
    timedOut,
    onDisconnect(presenceId) {
      disconnected.push(presenceId);
    },
    onLivenessTimeout(presenceId) {
      timedOut.push(presenceId);
    },
  };
}

async function flush(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

describe("presence-transport-pty (§4.3 obligations)", () => {
  it("deliver to a bound live child is a REAL effect — the DeliveryFrame line lands on stdin (G10)", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
    const child = new FakePtyChild();
    const pid = presenceId("live");
    assert.equal(transport.bind(pid, child), true);

    const message = makeMessage("hello terminal");
    const report = await transport.deliver(pid, { message, priority: "normal" });
    assert.deepEqual(report, { kind: "effect" });

    const received = child.receivedJson() as { kind: string; message: Message; priority: string; presenceId: string }[];
    assert.equal(received.length, 1);
    assert.equal(received[0]?.kind, "delivery");
    assert.equal(received[0]?.message.id, message.id);
    assert.equal(received[0]?.message.body.text, "hello terminal");
    assert.equal(received[0]?.presenceId, pid);
    await transport.closeAll();
  });

  it("the urgent steer is deliver with priority urgent — the priority crosses (MSG-008)", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
    const child = new FakePtyChild();
    const pid = presenceId("urgent");
    transport.bind(pid, child);

    const message = makeMessage("steer me");
    const report = await transport.deliver(pid, { message, priority: "urgent" });
    assert.equal(report.kind, "effect");
    const received = child.receivedJson() as { priority: string }[];
    assert.equal(received[0]?.priority, "urgent");
    await transport.closeAll();
  });

  it("push carries the SubscriptionMessage verbatim onto stdin (observation lane)", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
    const child = new FakePtyChild();
    const pid = presenceId("push");
    transport.bind(pid, child);

    const frame: SubscriptionMessage = {
      kind: "started",
      subscriptionId: "subscription_1" as SubscriptionMessage["subscriptionId"],
    };
    const report = await transport.push(pid, frame);
    assert.equal(report.kind, "effect");
    assert.deepEqual(child.receivedJson()[0], frame);
    await transport.closeAll();
  });

  it("an unbound presence is a TRANSIENT failure (the bind window), never presence-gone", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
    const report = await transport.deliver(presenceId("unbound"), {
      message: makeMessage("early"),
      priority: "normal",
    });
    assert.equal(report.kind, "failure");
    if (report.kind === "failure") {
      assert.equal(report.retryable, true);
      assert.equal(report.permanent, undefined);
    }
    await transport.closeAll();
  });

  it("a dead child never reports effect: presence-gone pre-teardown; exit raises onDisconnect (R9)", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
    const liveness = livenessRecorder();
    transport.attachLiveness(liveness);

    // Pre-teardown: the child is gone but the exit event has not been
    // processed — the lane is still in the table and reports presence-gone.
    const goner = new FakePtyChild();
    const gonerPid = presenceId("goner");
    transport.bind(gonerPid, goner);
    goner.vanish();
    const gone = await transport.deliver(gonerPid, { message: makeMessage("too late"), priority: "normal" });
    assert.equal(gone.kind, "failure");
    if (gone.kind === "failure") {
      assert.equal(gone.retryable, false);
      assert.equal(gone.permanent, "presence-gone");
    }

    // Exit: the death funnels into the core's single close path.
    const child = new FakePtyChild();
    const pid = presenceId("dying");
    transport.bind(pid, child);
    child.exit(0);
    await flush();
    assert.deepEqual(liveness.disconnected, [pid], "exit funnels into the single close path");

    // Post-teardown the lane is unbound — still never an effect (G10).
    const report = await transport.deliver(pid, { message: makeMessage("after"), priority: "normal" });
    assert.equal(report.kind, "failure");
    await transport.closeAll();
  });

  it("bind returns false for an already-dead child (the spawn→bind window) — no ghost lane", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
    const child = new FakePtyChild();
    child.exit(1);
    await flush();
    assert.equal(transport.bind(presenceId("ghost"), child), false);
    assert.equal(transport.childCount, 0);
    await transport.closeAll();
  });

  it("a write failure on a live child is transient; on a dying child it is presence-gone", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
    const live = new FakePtyChild();
    const livePid = presenceId("flaky");
    transport.bind(livePid, live);
    live.failNextWrite();
    const transient = await transport.deliver(livePid, { message: makeMessage("flaky"), priority: "normal" });
    assert.equal(transient.kind, "failure");
    if (transient.kind === "failure") assert.equal(transient.retryable, true);

    const dying = new FakePtyChild();
    const dyingPid = presenceId("mid-write");
    transport.bind(dyingPid, dying);
    dying.failNextWrite();
    dying.vanish(); // died before the write confirms
    const gone = await transport.deliver(dyingPid, { message: makeMessage("mid"), priority: "normal" });
    assert.equal(gone.kind, "failure");
    if (gone.kind === "failure") {
      assert.equal(gone.retryable, false);
      assert.equal(gone.permanent, "presence-gone");
    }
    await transport.closeAll();
  });

  it("a hung write is cut by the bounded effect deadline — transient failure, never a hung caller (§4.3)", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0, effectDeadlineMs: 25 });
    const child = new FakePtyChild();
    child.hangWrites = true;
    const pid = presenceId("hung");
    transport.bind(pid, child);

    const started = Date.now();
    const report = await transport.deliver(pid, { message: makeMessage("stuck"), priority: "normal" });
    assert.ok(Date.now() - started < 2_000, "the deadline cut in promptly");
    assert.equal(report.kind, "failure");
    if (report.kind === "failure") assert.equal(report.retryable, true);
    await transport.closeAll();
  });

  it("the signal-0 probe catches an out-of-band death: onLivenessTimeout, then teardown via onDisconnect", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 15 });
    const liveness = livenessRecorder();
    transport.attachLiveness(liveness);
    const child = new FakePtyChild();
    const pid = presenceId("vanished");
    transport.bind(pid, child);

    child.vanish(); // no exit event — only the probe can see it
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(liveness.timedOut, [pid], "the probe reported the liveness failure");
    assert.deepEqual(liveness.disconnected, [pid], "teardown funnels into the single close path");
    assert.equal(transport.childCount, 0);
    await transport.closeAll();
  });

  it("open() spawns through the INJECTED spawn function and binds the child", async () => {
    const spawned: { command: string; args: readonly string[] }[] = [];
    const transport = createPtyPresenceTransport({
      livenessIntervalMs: 0,
      spawn: (command, args) => {
        spawned.push({ command, args });
        return new FakePtyChild();
      },
    });
    const pid = presenceId("spawned");
    transport.open(pid, "agent-cli", ["--watch"]);
    assert.deepEqual(spawned, [{ command: "agent-cli", args: ["--watch"] }]);
    const report = await transport.deliver(pid, { message: makeMessage("via spawn"), priority: "normal" });
    assert.equal(report.kind, "effect");
    await transport.closeAll();
  });

  it("F4: open() surfaces the spawn→bind window — a dead-on-arrival child raises onDisconnect, no ghost lane", async () => {
    const transport = createPtyPresenceTransport({
      livenessIntervalMs: 0,
      spawn: () => {
        const child = new FakePtyChild();
        child.exit(1); // dead before open() can bind it
        return child;
      },
    });
    const liveness = livenessRecorder();
    transport.attachLiveness(liveness);

    const pid = presenceId("doa");
    transport.open(pid, "agent-cli");
    // open owns the spawn, so it reports the window itself: the minted
    // Presence funnels into the core's single close path (R9), exactly as if
    // the child had died a tick later. Swallowing it leaked a ghost (F4).
    assert.deepEqual(liveness.disconnected, [pid], "the bind failure is surfaced, not swallowed");
    assert.equal(transport.childCount, 0, "no ghost lane is tracked");
    const report = await transport.deliver(pid, { message: makeMessage("ghost"), priority: "normal" });
    assert.equal(report.kind, "failure", "no effect on a lane that never bound (G10)");
    await transport.closeAll();
  });

  it("F5: closeAll escalates — SIGTERM, a bounded grace, SIGKILL for the survivor, then the single-close-path teardown", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0, closeGraceMs: 10 });
    const liveness = livenessRecorder();
    transport.attachLiveness(liveness);
    const stubborn = new FakePtyChild();
    stubborn.surviveTerm = true; // ignores SIGTERM; only SIGKILL kills
    const pid = presenceId("stubborn");
    transport.bind(pid, stubborn);

    await transport.closeAll(); // resolves — the grace is bounded, never a hang
    assert.deepEqual(stubborn.signalsReceived, [undefined, "SIGKILL"], "SIGTERM asked, SIGKILL enforced");
    assert.equal(stubborn.killed, true, "the survivor did not outlive closeAll");
    assert.deepEqual(liveness.disconnected, [pid], "teardown still funnels into the single close path (R9)");
    assert.equal(transport.childCount, 0);
  });

  it("SMOKE: a real `cat` process receives the delivery bytes (dependency-free spawn + stdin write)", async () => {
    const transport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
    const liveness = livenessRecorder();
    transport.attachLiveness(liveness);
    const child = spawn("cat", [], { stdio: ["pipe", "pipe", "inherit"] });
    const echoed: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => echoed.push(chunk.toString("utf8")));
    const pid = presenceId("real-cat");

    try {
      assert.equal(transport.bind(pid, child), true);
      const message = makeMessage("real bytes");
      const report = await transport.deliver(pid, { message, priority: "normal" });
      assert.deepEqual(report, { kind: "effect" }, "the write to a real process's stdin confirmed");

      await new Promise((resolve) => setTimeout(resolve, 150));
      const line = echoed.join("").split("\n").find((candidate) => candidate.length > 0);
      assert.ok(line, "cat echoed the delivery line back");
      const parsed = JSON.parse(line) as { kind: string; message: Message };
      assert.equal(parsed.kind, "delivery");
      assert.equal(parsed.message.body.text, "real bytes");
    } finally {
      await transport.closeAll(); // kills the child through the adapter
    }
    assert.equal(child.exitCode !== null || child.killed, true, "closeAll killed the process");
  });
});
