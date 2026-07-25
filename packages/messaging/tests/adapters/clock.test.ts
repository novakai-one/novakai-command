/**
 * Clock/ID seam adapter checks (Messaging-Seams §5):
 * contract-source ID patterns, never-reissued uniqueness, seeded determinism,
 * movable fixed clock, and the §5.2 halt-class failure shape.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { idPatterns, MessagingError } from "../../public/contract/index.js";
import type { IdKind } from "../../public/contract/index.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import { createSystemClock } from "../../adapters/clock-system.js";

describe("clock-seeded", () => {
  it("mints pattern-legal, never-reissued IDs for every mintable kind", () => {
    const clock = createSeededClock({ seed: "t1" });
    const patternByKind: Record<string, string> = {
      presence: idPatterns.PresenceId,
      thread: idPatterns.ThreadId,
      message: idPatterns.MessageId,
      delivery: idPatterns.DeliveryId,
      attempt: idPatterns.AttemptId,
      template: idPatterns.TemplateId,
      snapshot: idPatterns.SnapshotId,
      acceptance: idPatterns.AcceptanceId,
      contactpolicy: idPatterns.PolicyId,
      dndpolicy: idPatterns.PolicyId,
      subscription: idPatterns.SubscriptionId,
    };
    const seen = new Set<string>();
    for (const [kind, pattern] of Object.entries(patternByKind)) {
      const id = clock.newId(kind as IdKind);
      assert.match(id, new RegExp(pattern), `${kind} id matches its contract pattern`);
      assert.ok(!seen.has(id), "never reissued");
      seen.add(id);
    }
  });

  it("is deterministic: same seed, same call order → same IDs", () => {
    const a = createSeededClock({ seed: "det" });
    const b = createSeededClock({ seed: "det" });
    assert.equal(a.newId("message"), b.newId("message"));
    assert.equal(a.newId("thread"), b.newId("thread"));
  });

  it("now() is fixed and movable", () => {
    const clock = createSeededClock({ seed: "t2", now: "2026-02-01T10:00:00.000Z" });
    assert.equal(clock.now(), "2026-02-01T10:00:00.000Z");
    clock.advance(60_000);
    assert.equal(clock.now(), "2026-02-01T10:01:00.000Z");
    clock.setNow("2026-03-01T00:00:00.000Z");
    assert.equal(clock.now(), "2026-03-01T00:00:00.000Z");
  });

  it("rejects a pattern-breaking seed with halt-class DependencyUnavailable{clock} (§5.2)", () => {
    assert.throws(
      () => createSeededClock({ seed: "bad seed!" }),
      (error: unknown) =>
        error instanceof MessagingError &&
        error.name === "DependencyUnavailable" &&
        error.fields["dependency"] === "clock" &&
        error.retryable === false,
    );
  });
});

describe("clock-system", () => {
  it("mints 128-bit random pattern-legal IDs, never equal", () => {
    const clock = createSystemClock();
    const a = clock.newId("message");
    const b = clock.newId("message");
    assert.match(a, new RegExp(idPatterns.MessageId));
    assert.notEqual(a, b);
  });

  it("now() is an ISO timestamp", () => {
    const clock = createSystemClock();
    assert.match(clock.now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
