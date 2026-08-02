/**
 * B3c — the durable Agent inbox and endpoint, at the store seam (§8.1, §13.6).
 *
 * These tests cross the store seam, not the capability API, because that is
 * where the atomicity claims live: "one StoreOp remains one atomic Foundation
 * object append" and "no queued Message can be claimed by both endpoints" are
 * store-level guarantees. The capability tests above them assume these hold.
 *
 * The memory adapter is the substrate here only because the SEMANTICS are
 * shared: store-shared is the one implementation both adapters wrap, so a
 * semantic proved here holds for the Foundation-backed adapter too. The
 * Foundation adapter's own suite proves the DURABILITY half separately.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "../../adapters/store-memory.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import type { MessagingStore } from "../../seams/store.js";
import type {
  AgentEndpointClaim,
  AgentEndpointClaimId,
  AgentId,
  AgentInboxItem,
  AgentInboxItemId,
  AgentRunId,
  MessagingStoreOpId,
  TerminalSessionId,
} from "../contract/records.js";
import type { MessageId } from "../../public/contract/index.js";

const AGENT = "agent_a" as AgentId;
const RUN_1 = "agentRun_1" as AgentRunId;
const RUN_2 = "agentRun_2" as AgentRunId;
const TERMINAL_1 = "terminal_1" as TerminalSessionId;
const TERMINAL_2 = "terminal_2" as TerminalSessionId;

function claim(overrides: Partial<AgentEndpointClaim> = {}): AgentEndpointClaim {
  return {
    id: `agentEndpoint_g${overrides.endpointGeneration ?? 0}` as AgentEndpointClaimId,
    kind: "agentEndpointClaim",
    schemaVersion: 1,
    entityRevision: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    permissionLevel: "private",
    createdBy: "sys_agent_runtime",
    lastStoreOpId: "messagingStoreOp_seed" as MessagingStoreOpId,
    agentId: AGENT,
    agentRunId: RUN_1,
    terminalSessionId: TERMINAL_1,
    endpointGeneration: 0,
    state: "reserved",
    ...overrides,
  };
}

function item(overrides: Partial<AgentInboxItem> = {}): AgentInboxItem {
  return {
    id: `agentInbox_${overrides.messageId ?? "m1"}` as AgentInboxItemId,
    kind: "agentInboxItem",
    schemaVersion: 1,
    entityRevision: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    permissionLevel: "private",
    createdBy: "person_chris",
    lastStoreOpId: "messagingStoreOp_seed" as MessagingStoreOpId,
    agentId: AGENT,
    messageId: (overrides.messageId ?? "message_m1") as MessageId,
    acceptedSequence: 1,
    state: "queued",
    ...overrides,
  };
}

async function store(): Promise<MessagingStore> {
  return createMemoryStore(createSeededClock({ seed: "b3c" }));
}

test("an endpoint claim commits and is readable as the Agent's current endpoint", async () => {
  const s = await store();
  const committed = await s.commitAgentEndpointClaim({
    claim: claim(), expectedEndpointGeneration: -1,
  });
  assert.equal(committed.kind, "ok");

  const current = await s.getAgentEndpoint(AGENT);
  assert.equal(current.kind, "ok");
  if (current.kind !== "ok") return;
  assert.equal(current.value?.agentRunId, RUN_1);
  assert.equal(current.value?.endpointGeneration, 0);
});

test("a claim against a stale generation is refused, not silently applied", async () => {
  // Two Runtimes racing a continuation both believe they hold generation 0.
  // If the second one wins by writing anyway, the Agent has two live endpoints
  // and a queued Message can be claimed by both (§13.6 forbids exactly this).
  const s = await store();
  await s.commitAgentEndpointClaim({ claim: claim(), expectedEndpointGeneration: -1 });

  const stale = await s.commitAgentEndpointClaim({
    claim: claim({ endpointGeneration: 1, agentRunId: RUN_2 }),
    expectedEndpointGeneration: -1,
  });
  assert.equal(stale.kind, "error");
  if (stale.kind !== "error") return;
  assert.equal(stale.error.name, "RevisionConflict");

  const current = await s.getAgentEndpoint(AGENT);
  assert.equal(current.kind === "ok" && current.value?.agentRunId, RUN_1);
});

test("inbox items commit with the acceptance and are listable per Agent", async () => {
  const s = await store();
  const one = await s.transitionAgentInboxItem(item({ messageId: "message_m1" as MessageId }));
  const two = await s.transitionAgentInboxItem(item({ messageId: "message_m2" as MessageId }));
  assert.equal(one.kind, "ok");
  assert.equal(two.kind, "ok");

  const listed = await s.listAgentInbox(AGENT);
  assert.equal(listed.kind, "ok");
  if (listed.kind !== "ok") return;
  assert.deepEqual(listed.value.map((i) => i.messageId).sort(), ["message_m1", "message_m2"]);
});

test("endpoint transfer moves queued items to the new claim atomically", async () => {
  const s = await store();
  await s.commitAgentEndpointClaim({ claim: claim(), expectedEndpointGeneration: -1 });
  const old = claim({ state: "draining", cutoffMessageSequence: 7 });
  await s.commitAgentEndpointClaim({ claim: old, expectedEndpointGeneration: 0 });

  const queued = item({ messageId: "message_m1" as MessageId });
  await s.transitionAgentInboxItem(queued);

  const next = claim({
    id: "agentEndpoint_g1" as AgentEndpointClaimId,
    endpointGeneration: 1, agentRunId: RUN_2, terminalSessionId: TERMINAL_2, state: "active",
  });
  const moved = await s.transferAgentEndpoint({
    oldClaim: { ...old, state: "closed" },
    newClaim: next,
    inboxItems: [{ ...queued, endpointClaimId: next.id }],
    expectedEndpointGeneration: 0,
  });
  assert.equal(moved.kind, "ok");

  const current = await s.getAgentEndpoint(AGENT);
  assert.equal(current.kind === "ok" && current.value?.agentRunId, RUN_2);
  assert.equal(current.kind === "ok" && current.value?.state, "active");

  const listed = await s.listAgentInbox(AGENT);
  assert.equal(listed.kind, "ok");
  if (listed.kind !== "ok") return;
  assert.equal(listed.value[0]?.endpointClaimId, next.id);

  // The old claim survives as closed history — the endpoint moved, it was not
  // erased. §13.6's "old Run final" is a state, not a deletion.
  const claims = await s.listAgentEndpointClaims(AGENT);
  assert.equal(claims.kind, "ok");
  if (claims.kind !== "ok") return;
  assert.equal(claims.value.length, 2);
  assert.equal(claims.value.find((c) => c.endpointGeneration === 0)?.state, "closed");
});

test("a transfer against the wrong generation changes nothing", async () => {
  const s = await store();
  await s.commitAgentEndpointClaim({ claim: claim(), expectedEndpointGeneration: -1 });
  const queued = item();
  await s.transitionAgentInboxItem(queued);

  const refused = await s.transferAgentEndpoint({
    oldClaim: claim({ state: "closed" }),
    newClaim: claim({
      id: "agentEndpoint_g1" as AgentEndpointClaimId,
      endpointGeneration: 1, agentRunId: RUN_2, state: "active",
    }),
    inboxItems: [queued],
    expectedEndpointGeneration: 5,
  });
  assert.equal(refused.kind, "error");

  const current = await s.getAgentEndpoint(AGENT);
  assert.equal(current.kind === "ok" && current.value?.agentRunId, RUN_1);
  assert.equal(current.kind === "ok" && current.value?.state, "reserved");
  const listed = await s.listAgentInbox(AGENT);
  assert.equal(listed.kind === "ok" && listed.value[0]?.endpointClaimId, undefined);
});

test("a submitted-unconfirmed item is never moved by a transfer", async () => {
  // §13.6: "submitted-unconfirmed old input remains attached to the old
  // endpoint and is never redirected." The keystrokes reached the old PTY;
  // re-sending them to the new Run would double-deliver a Message a human
  // may already have answered.
  const s = await store();
  await s.commitAgentEndpointClaim({ claim: claim(), expectedEndpointGeneration: -1 });
  const old = claim();
  const unconfirmed = item({
    state: "submitted-unconfirmed", endpointClaimId: old.id,
  });
  await s.transitionAgentInboxItem(unconfirmed);

  const next = claim({
    id: "agentEndpoint_g1" as AgentEndpointClaimId,
    endpointGeneration: 1, agentRunId: RUN_2, state: "active",
  });
  const moved = await s.transferAgentEndpoint({
    oldClaim: { ...old, state: "closed" },
    newClaim: next,
    inboxItems: [{ ...unconfirmed, endpointClaimId: next.id }],
    expectedEndpointGeneration: 0,
  });
  assert.equal(moved.kind, "error");
  if (moved.kind !== "error") return;
  assert.equal(moved.error.name, "StateConflict");

  const listed = await s.listAgentInbox(AGENT);
  assert.equal(listed.kind === "ok" && listed.value[0]?.endpointClaimId, old.id);
});
