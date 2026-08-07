/**
 * What a READER is told about mail the store has already delivered — §19.2, §8.1.
 *
 * Exam rows D2 and E2 both read empty or stalled while the store holds the
 * truth (R4 brief; the R3 report's census of the exam's own data root shows
 * eleven durable acceptances and inbox items at `submitted-confirmed`). Two
 * separate read surfaces are responsible, and neither fix touches the other:
 *
 *   - §19.2's communication row reports `deliveryState` from the generic
 *     `Delivery` entity. For Agent-addressed mail that entity is a stub that is
 *     never transitioned, so the row says `pending` forever — next to an inbox
 *     item that says `submitted-confirmed`. §8.1's inbox item IS the delivery
 *     truth for an Agent, and the row did not carry it.
 *
 *   - `MessageAcceptance.state` is a constant. `queued-for-agent` is honest for
 *     a fresh accept; on the idempotent replay §12.5 requires, it reports the
 *     same word about a Message that has since reached the terminal. Three of
 *     the four states the sealed union publishes were unreachable, and the
 *     `nvk agent message` renderer has a branch for each of them.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "../../adapters/store-memory.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import { composeAgentMessaging } from "../core/compose.js";
import type { AgentMessagingContract } from "../contract/api.js";
import type { AgentId, AgentRunId } from "../contract/records.js";
import type { AuthenticatedPrincipal, SystemCommandContext } from "@novakai/foundation/contract";

const AGENT = "agent_22222222-2222-4222-8222-222222222222" as AgentId;
const RUN = "agentRun_019fc111-0000-7000-8000-000000000001" as AgentRunId;
const TERMINAL = "terminalSession_019fc111-0000-7000-8000-000000000001";

const human: AuthenticatedPrincipal = {
  id: "person_chris" as never, kind: "human", verifiedScopes: [],
};

let ops = 0;
const humanCtx = () => ({
  principal: human,
  clientOpId: `op_human_${(ops += 1)}` as never,
  traceId: "trace_human" as never,
  contractVersion: 1 as const,
});

const runtimeCtx = (): SystemCommandContext<"sys_agent_runtime"> => ({
  principal: { id: "sys_agent_runtime", kind: "system", verifiedScopes: [] },
  clientOpId: `op_runtime_${(ops += 1)}` as never,
  traceId: "trace_runtime" as never,
  contractVersion: 1,
});

function messaging(seed: string): AgentMessagingContract {
  const clock = createSeededClock({ seed });
  return composeAgentMessaging({ store: createMemoryStore(clock), clock });
}

/** A live shift with an active endpoint, ready to be typed into. */
async function liveShift(api: AgentMessagingContract): Promise<void> {
  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT, agentRunId: RUN,
    terminalSessionId: TERMINAL as never, expectedEndpointGeneration: -1,
  });
  if (!reserved.ok) throw new Error(reserved.error.code);
  const active = await api.activateAgentEndpointClaim(runtimeCtx(), reserved.value.id);
  assert.equal(active.ok, true);
}

/** Claim the queued item and report the outcome the terminal observed. */
async function deliver(
  api: AgentMessagingContract,
  outcome: "submitted-confirmed" | "submitted-unconfirmed",
): Promise<void> {
  const claimed = await api.claimNextInboxItem(runtimeCtx(), AGENT);
  assert.equal(claimed.ok, true);
  if (!claimed.ok || claimed.value === null) throw new Error("nothing to claim");
  const recorded = await api.recordInboxSubmission(runtimeCtx(), {
    inboxItemId: claimed.value.id,
    outcome,
    terminalInputAttemptId: "terminalInputAttempt_read-truth" as never,
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.ok ? recorded.value.state : null, outcome);
}

test("D2 — a communication row reports the delivery truth its own inbox holds", async () => {
  const api = messaging("b3c-r4-d2");
  await liveShift(api);

  const sent = await api.sendAgentMessage(humanCtx(), {
    target: { kind: "agent", agentId: AGENT },
    text: "Please ignore this line. NVKHOREADTRUTH",
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;

  await deliver(api, "submitted-confirmed");

  // The durable §8.1 truth, first — this is what the store holds.
  const inbox = await api.listAgentInbox(human, { agentId: AGENT });
  assert.equal(inbox.ok, true);
  assert.deepEqual(
    inbox.ok ? inbox.value.items.map((item) => item.state) : null,
    ["submitted-confirmed"],
  );

  // And now the same fact, asked of the surface §19.2 publishes for it.
  const comms = await api.listAgentCommunications(human, {
    agentIds: [AGENT], limit: 50,
  });
  assert.equal(comms.ok, true);
  if (!comms.ok) return;
  const row = comms.value.items.find((item) => item.messageId === sent.value.messageId);
  assert.notEqual(row, undefined, "the Message is not in its own Agent's communications");
  assert.equal(row?.deliveryState, "submitted-confirmed",
    "the communication row still reports the never-transitioned Delivery stub");
  assert.equal(row?.inboxState, "submitted-confirmed");
  assert.equal(row?.direction, "to-agent");
});

test("D2 — a row for mail nobody has typed yet says queued, not pending", async () => {
  const api = messaging("b3c-r4-d2-queued");
  await liveShift(api);

  const sent = await api.sendAgentMessage(humanCtx(), {
    target: { kind: "agent", agentId: AGENT },
    text: "Ignore this line. NVKHOSTILLQUEUED",
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;

  const comms = await api.listAgentCommunications(human, {
    agentIds: [AGENT], limit: 50,
  });
  assert.equal(comms.ok, true);
  if (!comms.ok) return;
  const row = comms.value.items.find((item) => item.messageId === sent.value.messageId);
  assert.equal(row?.deliveryState, "queued");
  assert.equal(row?.inboxState, "queued");
});

test("E2 — an idempotent re-send reports where the Message actually got to", async () => {
  const api = messaging("b3c-r4-e2");
  await liveShift(api);

  const clientMessageId = "nvkho-read-truth-e2";
  const first = await api.sendAgentMessage(humanCtx(), {
    target: { kind: "agent", agentId: AGENT },
    text: "Ignore this line. NVKHOEXACTLYONCE",
    clientMessageId,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  // A fresh accept genuinely IS queued for the Agent, and says so.
  assert.equal(first.value.state, "queued-for-agent");
  assert.equal(first.value.duplicate, false);

  await deliver(api, "submitted-confirmed");

  const replay = await api.sendAgentMessage(humanCtx(), {
    target: { kind: "agent", agentId: AGENT },
    text: "Ignore this line. NVKHOEXACTLYONCE",
    clientMessageId,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;

  // Committed exactly once (§12.5's idempotency) …
  assert.equal(replay.value.duplicate, true);
  assert.equal(replay.value.messageId, first.value.messageId);
  // … and the acceptance names the state the item actually reached, rather
  // than repeating the word it was born with.
  assert.equal(replay.value.state, "submitted-confirmed",
    "the acceptance still says queued for a Message already typed into the terminal");
});

test("E2 — an unconfirmed submission is reported as uncertain, never as delivered", async () => {
  const api = messaging("b3c-r4-e2-uncertain");
  await liveShift(api);

  const clientMessageId = "nvkho-read-truth-e2-uncertain";
  const first = await api.sendAgentMessage(humanCtx(), {
    target: { kind: "agent", agentId: AGENT },
    text: "Ignore this line. NVKHOUNCERTAIN",
    clientMessageId,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  await deliver(api, "submitted-unconfirmed");

  const replay = await api.sendAgentMessage(humanCtx(), {
    target: { kind: "agent", agentId: AGENT },
    text: "Ignore this line. NVKHOUNCERTAIN",
    clientMessageId,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  // §8.1: the keystrokes reached the PTY and Novakai does not know whether the
  // provider read them. Reporting that as delivered is the one rounding-up
  // §20 exists to forbid.
  assert.equal(replay.value.state, "submitted-unconfirmed");
});
