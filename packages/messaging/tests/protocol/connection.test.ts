/**
 * protocol/connection regression proofs (F8/F9/F10) — against the REAL
 * protocol connection over a real core stack (memory seams), with the
 * transport edge faked only at the injection points the composition root
 * owns (send / bindPresence / pushSinkFor / closeConnection).
 *
 * F8: frame handling is serialized per connection — a pipelined
 *     OpenPresence→Subscribe pair executes in arrival order.
 * F9: a non-MessagingError throw at the protocol edge maps to an honest
 *     DependencyUnavailable{dependency:"internal", retryable:false}, never
 *     a dependency-less "retry me" laundering.
 * F10: a bind to a dead socket closes the minted Presence through the
 *      single close path (no ghost), the command fails honestly, and
 *      handleClose closes the connection's Presence even when unbound.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { DEFAULT_ROLE_GRANTS } from "../../contract/index.js";
import type { AuthorityConfig } from "../../contract/index.js";
import type { SubscriptionMessage } from "../../contract/index.js";
import { createCoreStack } from "../../contract/compose/stack.js";
import type { CoreStack } from "../../contract/compose/stack.js";
import { createProtocolConnection } from "../../adapters/standalone/connection.js";
import type { ProtocolConnection } from "../../adapters/standalone/connection.js";

const AUTHORITY: AuthorityConfig = {
  principals: [
    { token: "tok-alice", personId: "person_alice" as never, roles: ["Worker"] },
    { token: "tok-bob", personId: "person_bob" as never, roles: ["Worker"] },
  ],
  roleGrants: DEFAULT_ROLE_GRANTS,
};

type Frame = Record<string, unknown>;

interface Harness {
  stack: CoreStack;
  connection: ProtocolConnection;
  frames: Frame[];
  pushed: SubscriptionMessage[];
}

function makeHarness(bindResult = true): Harness {
  const stack = createCoreStack({ authority: AUTHORITY });
  const frames: Frame[] = [];
  const pushed: SubscriptionMessage[] = [];
  const connection = createProtocolConnection({
    stack,
    send: (frame) => frames.push(frame as unknown as Frame),
    bindPresence: () => bindResult,
    pushSinkFor: () => async (frame: SubscriptionMessage) => {
      pushed.push(frame);
      return { kind: "effect" };
    },
    closeConnection: () => {},
  });
  return { stack, connection, frames, pushed };
}

async function authenticate(harness: Harness, token = "tok-alice"): Promise<void> {
  await harness.connection.handleText(
    JSON.stringify({ kind: "authenticate", requestId: "auth-1", credential: { token } }),
  );
  const authenticated = harness.frames.find((frame) => frame["kind"] === "authenticated");
  assert.ok(authenticated, "authenticated");
}

function errorFrames(frames: Frame[]): { name: string; retryable: boolean; fields: Record<string, unknown> }[] {
  return frames
    .filter((frame) => frame["kind"] === "error")
    .map((frame) => frame["error"] as { name: string; retryable: boolean; fields: Record<string, unknown> });
}

describe("F8 — per-connection frame serialization", () => {
  it("pipelined OpenPresence→Subscribe executes in arrival order (no spurious presence rejection)", async () => {
    const harness = makeHarness();
    await authenticate(harness);

    // Fire both frames back-to-back WITHOUT awaiting — the pipelining race.
    const open = harness.connection.handleText(
      JSON.stringify({ kind: "command", requestId: "c1", name: "OpenPresence", input: { transport: "ws" } }),
    );
    const subscribe = harness.connection.handleText(
      JSON.stringify({ kind: "subscribe", requestId: "s1", input: { events: ["MessageCommitted"] } }),
    );
    await Promise.all([open, subscribe]);

    const errors = errorFrames(harness.frames);
    assert.deepEqual(errors, [], "F8: no spurious ValidationFailed{presence} on a pipelined pair");
    const started = harness.pushed.find((frame) => frame.kind === "started");
    assert.ok(started, "the Subscribe succeeded — started is the stream's ack");
    const commandResult = harness.frames.find(
      (frame) => frame["kind"] === "command-result" && frame["name"] === "OpenPresence",
    );
    assert.ok(commandResult, "the OpenPresence result precedes (arrival order)");
    await harness.stack.close();
  });
});

describe("F9 — honest internal-error mapping at the protocol edge", () => {
  it("a non-MessagingError throw maps to DependencyUnavailable{dependency:internal, retryable:false}", async () => {
    const harness = makeHarness();
    const rigged: CoreStack = {
      ...harness.stack,
      authenticate: async () => {
        throw new Error("core bug (test)");
      },
    };
    const frames: Frame[] = [];
    const connection = createProtocolConnection({
      stack: rigged,
      send: (frame) => frames.push(frame as unknown as Frame),
      bindPresence: () => true,
      pushSinkFor: () => async () => ({ kind: "effect" }),
      closeConnection: () => {},
    });

    await connection.handleText(
      JSON.stringify({ kind: "authenticate", requestId: "auth-1", credential: { token: "tok-alice" } }),
    );
    const errors = errorFrames(frames);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.name, "DependencyUnavailable");
    assert.equal(errors[0]?.retryable, false, "an internal failure is NOT a retry-me signal (F9)");
    assert.equal(
      errors[0]?.fields["dependency"],
      "internal",
      "the frozen shape carries a dependency field — tolerate-unknown treats it as non-retryable",
    );
    await harness.stack.close();
  });
});

describe("F10 — no ghost Presence in the accept→bind window", () => {
  it("bind to a dead socket closes the minted Presence, fails the command, and deliveries stay pending", async () => {
    const harness = makeHarness(false); // socket died before bind
    await authenticate(harness, "tok-alice");

    await harness.connection.handleText(
      JSON.stringify({ kind: "command", requestId: "c1", name: "OpenPresence", input: { transport: "ws" } }),
    );

    const errors = errorFrames(harness.frames);
    assert.equal(errors.length, 1, "the command fails honestly (OpenPresence catalogue)");
    assert.equal(errors[0]?.name, "DependencyUnavailable");
    assert.equal(
      harness.stack.registry.all().length,
      0,
      "F10: NO ghost Presence — the minted Presence was closed through the single close path",
    );

    // A message to the presence-less principal stays pending (R5 no-presence
    // rule) — it must NOT burn retry budget to failed against a dead lane.
    const bob = await harness.stack.authenticate({ token: "tok-bob" });
    assert.equal(bob.kind, "authenticated");
    if (bob.kind !== "authenticated") return;
    const alice = await harness.stack.authenticate({ token: "tok-alice" });
    assert.equal(alice.kind, "authenticated");
    if (alice.kind !== "authenticated") return;
    const policy = await alice.session.setContactPolicy({
      allowlist: ["person_bob"],
      defaultRule: "deny",
    });
    assert.equal(policy.kind, "ok");
    const sent = await bob.session.sendMessage({
      address: "person:person_alice",
      body: { text: "ghost check" },
      priority: "normal",
      clientMessageId: "f10-1",
    });
    assert.equal(sent.kind, "ok");
    if (sent.kind !== "ok") return;
    const deliveries = await bob.session.getDelivery({ messageId: sent.value.messageId });
    assert.equal(deliveries.kind, "ok");
    if (deliveries.kind !== "ok") return;
    assert.deepEqual(
      deliveries.value.deliveries.map((delivery) => delivery.state),
      ["pending"],
      "no-presence rule: pending, never failed (F10: no retry budget burned on a ghost)",
    );
    await harness.stack.close();
  });

  it("handleClose closes the connection's Presence (even one never bound to a socket)", async () => {
    const harness = makeHarness(true);
    await authenticate(harness, "tok-alice");

    await harness.connection.handleText(
      JSON.stringify({ kind: "command", requestId: "c1", name: "OpenPresence", input: { transport: "ws" } }),
    );
    assert.equal(harness.stack.registry.all().length, 1, "presence minted");

    await harness.connection.handleClose();
    assert.equal(
      harness.stack.registry.all().length,
      0,
      "F10: connection close closes its Presence through the single close path",
    );
    await harness.stack.close();
  });
});
