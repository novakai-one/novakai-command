/**
 * B3c — Messaging's production journal, on Foundation's one engine (§8, §18.1).
 *
 * The claim under test is narrow and load-bearing: "every production Messaging
 * mutation persists exactly one MessagingStoreOpRecord through Foundation
 * before StoreCore applies it in memory", and "no Message, Thread, Delivery,
 * acceptance, endpoint, or inbox JSONL file exists outside
 * messagingStoreOps.jsonl".
 *
 * The second half is testable by looking at the directory, and that is exactly
 * what the last test does — a claim about which files exist is not provable by
 * reading code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openFoundationMessagingStore } from "../adapters/store-foundation.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import type { MessagingStore } from "../../seams/store.js";
import type {
  AgentEndpointClaim,
  AgentEndpointClaimId,
  AgentId,
  AgentRunId,
  MessagingStoreOpId,
  TerminalSessionId,
} from "../contract/records.js";

const AGENT = "agent_a" as AgentId;

function claim(generation: number, state: AgentEndpointClaim["state"]): AgentEndpointClaim {
  return {
    id: `agentEndpoint_g${generation}` as AgentEndpointClaimId,
    kind: "agentEndpointClaim",
    schemaVersion: 1,
    entityRevision: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    permissionLevel: "private",
    createdBy: "sys_agent_runtime",
    lastStoreOpId: "messagingStoreOp_seed" as MessagingStoreOpId,
    agentId: AGENT,
    agentRunId: "agentRun_1" as AgentRunId,
    terminalSessionId: "terminal_1" as TerminalSessionId,
    endpointGeneration: generation,
    state,
  };
}

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "nvk-b3c-msgstore-"));
}

async function open(root: string): Promise<MessagingStore> {
  return openFoundationMessagingStore(createSeededClock({ seed: "b3c" }), {
    root, dataRoot: path.join(root, "stores"),
  });
}

test("a committed endpoint claim survives close and reopen", async () => {
  const root = tempRoot();
  try {
    const first = await open(root);
    await first.commitAgentEndpointClaim({
      claim: claim(0, "active"), expectedEndpointGeneration: -1,
    });
    await first.close();

    const second = await open(root);
    const current = await second.getAgentEndpoint(AGENT);
    assert.equal(current.kind, "ok");
    if (current.kind !== "ok") return;
    assert.equal(current.value?.endpointGeneration, 0);
    assert.equal(current.value?.state, "active");
    await second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each StoreOp is exactly one Foundation record line", async () => {
  const root = tempRoot();
  try {
    const store = await open(root);
    await store.commitAgentEndpointClaim({
      claim: claim(0, "reserved"), expectedEndpointGeneration: -1,
    });
    await store.commitAgentEndpointClaim({
      claim: claim(0, "active"), expectedEndpointGeneration: 0,
    });
    await store.close();

    const file = path.join(root, "stores", "messagingStoreOps.jsonl");
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 2, "two mutations must be two record lines");

    // §18.2: the line is Foundation's existing {envelope, payload, meta} —
    // Build 3 adds no `owner`, `streamId`, `sequence`, `operation` or second
    // CAS field to it. `meta.version` is the only CAS counter.
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), ["envelope", "meta", "payload"]);
      const meta = parsed["meta"] as Record<string, unknown>;
      assert.equal(typeof meta["version"], "number");
      assert.equal("sequence" in parsed, false);
      assert.equal("owner" in parsed, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no Messaging JSONL file exists outside messagingStoreOps.jsonl", async () => {
  // §18.1's flat inventory is a claim about the DIRECTORY, so the directory is
  // what gets read. A Thread/Delivery/inbox file appearing beside the journal
  // is the exact "second store format" the two laws forbid.
  const root = tempRoot();
  try {
    const store = await open(root);
    await store.commitAgentEndpointClaim({
      claim: claim(0, "active"), expectedEndpointGeneration: -1,
    });
    await store.close();

    const files = readdirSync(path.join(root, "stores")).filter((n) => n.endsWith(".jsonl"));
    const messagingOwned = files.filter((name) => name !== "traces.jsonl");
    assert.deepEqual(messagingOwned, ["messagingStoreOps.jsonl"],
      `Messaging wrote files it does not own: ${files.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("storeSequence is monotonic and replay sorts by it", async () => {
  const root = tempRoot();
  try {
    const store = await open(root);
    for (const state of ["reserved", "active", "draining"] as const) {
      await store.commitAgentEndpointClaim({
        claim: claim(0, state), expectedEndpointGeneration: 0 - (state === "reserved" ? 1 : 0),
      });
    }
    await store.close();

    const file = path.join(root, "stores", "messagingStoreOps.jsonl");
    const sequences = readFileSync(file, "utf8").split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { payload: { storeSequence: number } }).payload.storeSequence);
    assert.deepEqual(sequences, [1, 2, 3]);

    // A reopened store must continue ABOVE the migrated/persisted maximum,
    // never restart at 1 — a reissued sequence makes two different operations
    // indistinguishable in replay order.
    const reopened = await open(root);
    await reopened.commitAgentEndpointClaim({
      claim: claim(1, "active"), expectedEndpointGeneration: 0,
    });
    await reopened.close();
    const after = readFileSync(file, "utf8").split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { payload: { storeSequence: number } }).payload.storeSequence);
    assert.deepEqual(after, [1, 2, 3, 4]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retried operation with the same key and digest is idempotent", async () => {
  // §8.1: "A retry reads the existing record and requires the same
  // payloadDigest." Without this, a crash between Foundation's append and
  // StoreCore's in-memory apply turns the recovery retry into a second record.
  const root = tempRoot();
  try {
    const store = await open(root);
    const target = claim(0, "active");
    await store.commitAgentEndpointClaim({ claim: target, expectedEndpointGeneration: -1 });
    await store.close();

    // Replay the identical op through a fresh store: same operation key, same
    // digest. The record count must not grow.
    const reopened = await open(root);
    const repeat = await reopened.commitAgentEndpointClaim({
      claim: target, expectedEndpointGeneration: 0,
    });
    assert.equal(repeat.kind, "ok");
    await reopened.close();

    const lines = readFileSync(path.join(root, "stores", "messagingStoreOps.jsonl"), "utf8")
      .split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 1, "an identical retry appended a second record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
