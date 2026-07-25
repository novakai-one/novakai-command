/**
 * DEC-17 protocol frame validation: every inbound frame is parsed from
 * `unknown`; malformed frames produce a typed ValidationFailed (requestId
 * correlated when extractable) and NEVER throw. The error catalogue's names
 * cross the wire unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessagingError } from "../../public/index.js";
import {
  errorFrame,
  parseClientFrame,
  WS_PROTOCOL_VERSION,
} from "../../protocol/frames.js";

function expectInvalid(value: unknown, requestId?: string) {
  const result = parseClientFrame(value);
  assert.equal(result.ok, false, `must reject: ${JSON.stringify(value)}`);
  if (!result.ok) {
    assert.equal(result.error.name, "ValidationFailed");
    assert.equal(result.requestId, requestId);
  }
}

describe("protocol frame parsing (MSG-021 — from unknown, never throws)", () => {
  it("valid frames parse into typed ClientFrames", () => {
    const cases: [unknown, string][] = [
      [{ kind: "get-capabilities" }, "get-capabilities"],
      [{ kind: "authenticate", requestId: "r1", credential: { token: "t" } }, "authenticate"],
      [{ kind: "authenticate", requestId: "r1", credential: { token: "t" }, protocolVersion: WS_PROTOCOL_VERSION }, "authenticate"],
      [{ kind: "command", requestId: "r2", name: "SendMessage", input: { address: "person:person_x" } }, "command"],
      [{ kind: "query", requestId: "r3", name: "GetInbox", input: {} }, "query"],
      [{ kind: "query", requestId: "r3", name: "GetInbox" }, "query"],
      [{ kind: "subscribe", requestId: "r4", input: { events: ["MessageCommitted"] } }, "subscribe"],
      [{ kind: "unsubscribe", subscriptionId: "subscription_abc" }, "unsubscribe"],
    ];
    for (const [value, expectedKind] of cases) {
      const result = parseClientFrame(value);
      assert.equal(result.ok, true, `must accept: ${JSON.stringify(value)}`);
      if (result.ok) assert.equal(result.frame.kind, expectedKind);
    }
  });

  it("malformed frames are a typed ValidationFailed — never a throw", () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "command",
      [],
      {},
      { kind: "bogus" },
      { kind: 7 },
      { kind: "authenticate" }, // no requestId / credential
      { kind: "command", requestId: "r", name: "SendMessage" }, // no input
      { kind: "command", requestId: "r", name: "DeleteEverything", input: {} }, // not this slice's surface
      { kind: "query", requestId: "r", name: "DropTables" },
      { kind: "subscribe", requestId: "r" }, // no input
      { kind: "unsubscribe", subscriptionId: "not-a-subscription-id" },
      { kind: "authenticate", requestId: "", credential: {} }, // empty requestId
    ];
    for (const value of bad) {
      const result = parseClientFrame(value);
      assert.equal(result.ok, false, `must reject: ${JSON.stringify(value)}`);
      if (!result.ok) assert.equal(result.error.name, "ValidationFailed");
    }
  });

  it("requestId survives on malformed frames for correlation", () => {
    expectInvalid({ kind: "bogus", requestId: "r-99" }, "r-99");
    expectInvalid({ kind: "command", requestId: "r-100", name: "Nope", input: {} }, "r-100");
    expectInvalid({ nope: true }, undefined);
  });

  it("the full S4 command/query surface parses; unknown names are rejected honestly", () => {
    // S4 sealed: the template operations are part of the wire surface.
    for (const name of ["SendFromTemplate", "UpsertTemplate", "RetireTemplate"]) {
      const result = parseClientFrame({ kind: "command", requestId: "r5", name, input: {} });
      assert.equal(result.ok, true, `${name} parses (S4 surface is live)`);
    }
    const query = parseClientFrame({ kind: "query", requestId: "r5q", name: "ListTemplates", input: {} });
    assert.equal(query.ok, true, "ListTemplates parses (S4 surface is live)");

    const rejected = parseClientFrame({ kind: "command", requestId: "r5x", name: "NukeEverything", input: {} });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.name, "ValidationFailed");
  });

  it("errorFrame serializes the 13-error catalogue names unchanged", () => {
    const frame = errorFrame(
      new MessagingError("BlockedByContactPolicy", {
        message: "blocked",
        retryable: false,
        fields: { recipientId: "person_bob" },
      }),
      "r6",
    );
    assert.equal(frame.kind, "error");
    assert.equal(frame.requestId, "r6");
    assert.equal(frame.error.name, "BlockedByContactPolicy");
    assert.deepEqual(frame.error.fields, { recipientId: "person_bob" });
    assert.equal(frame.error.retryable, false);
  });
});
