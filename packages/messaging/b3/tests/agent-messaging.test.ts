/**
 * B3c — the Agent messaging capability (§12.5, §13.6, §19.2, red gate 12).
 *
 * These cross the PUBLIC capability contract, which is the point: the pre-build
 * hold-out exam failed on exactly this seam — `threadId` was required by
 * send/open and nothing minted one, so nothing outside the package could send
 * a Message at all. Every test here starts by obtaining a Thread the way a real
 * caller has to.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { composeAgentMessaging } from "../core/compose.js";
import { createMemoryStore } from "../../adapters/store-memory.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import type { AgentMessagingContract } from "../contract/api.js";
import type { AgentEndpointClaimId, AgentId, AgentRunId, TerminalSessionId } from "../contract/records.js";
import type {
  AuthenticatedPrincipal, CommandContext, SystemCommandContext,
} from "@novakai/foundation/contract";

const CHRIS = "human_chris";
const AGENT_A = "agent_aaaaaaaa-0000-4000-8000-000000000001" as AgentId;
const AGENT_B = "agent_bbbbbbbb-0000-4000-8000-000000000002" as AgentId;
const RUN_1 = "agentRun_01900000-0000-7000-8000-000000000001" as AgentRunId;
const RUN_2 = "agentRun_01900000-0000-7000-8000-000000000002" as AgentRunId;
const TERMINAL_1 = "terminal_01900000-0000-7000-8000-000000000001" as TerminalSessionId;
const TERMINAL_2 = "terminal_01900000-0000-7000-8000-000000000002" as TerminalSessionId;

const human: AuthenticatedPrincipal = {
  id: CHRIS as never, kind: "human", verifiedScopes: [],
};

const ctx = (): CommandContext => ({
  principal: human,
  clientOpId: "op_00000000-0000-4000-8000-000000000001" as never,
  traceId: "trace_00000000-0000-4000-8000-000000000001" as never,
  contractVersion: 1,
});

const runtimeCtx = (): SystemCommandContext<"sys_agent_runtime"> => ({
  principal: { id: "sys_agent_runtime", kind: "system", verifiedScopes: [] },
  clientOpId: "op_00000000-0000-4000-8000-000000000002" as never,
  traceId: "trace_00000000-0000-4000-8000-000000000002" as never,
  contractVersion: 1,
});

const transcriptCtx = (): SystemCommandContext<"sys_transcript"> => ({
  principal: { id: "sys_transcript", kind: "system", verifiedScopes: [] },
  clientOpId: "op_00000000-0000-4000-8000-000000000003" as never,
  traceId: "trace_00000000-0000-4000-8000-000000000003" as never,
  contractVersion: 1,
});

/** The store behind the last `messaging()`, so a test can read what was committed. */
let lastStore: ReturnType<typeof createMemoryStore> | null = null;

function messaging(): AgentMessagingContract {
  const store = createMemoryStore(createSeededClock({ seed: "b3c" }));
  lastStore = store;
  return composeAgentMessaging({
    store,
    clock: createSeededClock({ seed: "b3c" }),
  });
}

async function directThread(api: AgentMessagingContract, agentId: AgentId): Promise<string> {
  const thread = await api.ensureDirectThread(ctx(), {
    between: [{ kind: "human", personId: "person_chris" }, { kind: "agent", agentId }],
  });
  assert.equal(thread.ok, true);
  if (!thread.ok) throw new Error("no thread");
  return thread.value.id;
}

test("ensureDirectThread mints a Thread and is get-or-create", async () => {
  const api = messaging();
  const first = await directThread(api, AGENT_A);
  const second = await directThread(api, AGENT_A);
  assert.equal(first, second, "the same pair produced two Threads");
  assert.match(first, /^thread_/);
});

test("ensureGroupThread is order-independent: one group, not two", async () => {
  // A group is a SET of participants. If {A,B} and {B,A} minted different
  // Threads, Chris would open a conversation and find half the messages.
  const api = messaging();
  const forward = await api.ensureGroupThread(ctx(), {
    participants: [
      { kind: "human", personId: "person_chris" },
      { kind: "agent", agentId: AGENT_A },
      { kind: "agent", agentId: AGENT_B },
    ],
  });
  const reverse = await api.ensureGroupThread(ctx(), {
    participants: [
      { kind: "agent", agentId: AGENT_B },
      { kind: "agent", agentId: AGENT_A },
      { kind: "human", personId: "person_chris" },
    ],
  });
  assert.equal(forward.ok && reverse.ok, true);
  if (!forward.ok || !reverse.ok) return;
  assert.equal(forward.value.id, reverse.value.id);
});

test("a Message to an Agent with no live endpoint is accepted and queued", async () => {
  // DEC-B3V4-32: acceptance happens BEFORE endpoint selection. An Agent that is
  // mid-restart is not a reason to reject a Message.
  const api = messaging();
  const threadId = await directThread(api, AGENT_A);
  const sent = await api.sendAgentMessage(ctx(), {
    target: { kind: "agent", agentId: AGENT_A },
    threadId: threadId as never,
    text: "ping",
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.equal(sent.value.state, "queued-for-agent");
  assert.equal(sent.value.threadId, threadId);
  assert.notEqual(sent.value.inboxItemId, undefined);

  const inbox = await api.listAgentInbox(human, { agentId: AGENT_A });
  assert.equal(inbox.ok && inbox.value.items.length, 1);
  assert.equal(inbox.ok && inbox.value.items[0]?.state, "queued");
});

test("the same clientMessageId sends once, not twice", async () => {
  const api = messaging();
  const threadId = await directThread(api, AGENT_A);
  const input = {
    target: { kind: "agent", agentId: AGENT_A } as const,
    threadId: threadId as never,
    text: "ping",
    clientMessageId: "cmid-1",
  };
  const first = await api.sendAgentMessage(ctx(), input);
  const second = await api.sendAgentMessage(ctx(), input);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.value.messageId, first.value.messageId);
  assert.equal(second.value.duplicate, true);

  const inbox = await api.listAgentInbox(human, { agentId: AGENT_A });
  assert.equal(inbox.ok && inbox.value.items.length, 1);
});

test("an exact-run send fails once that Run's endpoint has a cutoff", async () => {
  const api = messaging();
  const threadId = await directThread(api, AGENT_A);
  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A, agentRunId: RUN_1, terminalSessionId: TERMINAL_1,
    expectedEndpointGeneration: -1,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  await api.activateAgentEndpointClaim(runtimeCtx(), reserved.value.id);

  const before = await api.sendAgentMessage(ctx(), {
    target: { kind: "exact-run", agentRunId: RUN_1 },
    threadId: threadId as never, text: "still live", clientMessageId: "cmid-live",
  });
  assert.equal(before.ok, true);

  // Continuation begins: the endpoint drains and takes a cutoff.
  const transferred = await api.transferAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A,
    expectedOldClaimId: reserved.value.id,
    newRunId: RUN_2,
    newTerminalSessionId: TERMINAL_2,
    oldFinalTranscriptWatermark: "pos-9",
    expectedEndpointGeneration: 0,
  });
  assert.equal(transferred.ok, true);

  const after = await api.sendAgentMessage(ctx(), {
    target: { kind: "exact-run", agentRunId: RUN_1 },
    threadId: threadId as never, text: "too late", clientMessageId: "cmid-late",
  });
  assert.equal(after.ok, false);
  if (after.ok) return;
  assert.equal(after.error.code, "ExactRunEndpointClosed");
});

test("continuation delivers every accepted Message to exactly the new endpoint", async () => {
  // §25-B3c's exit line, in one test: three Messages accepted across the whole
  // cutover window, and every one of them ends up pointed at the NEW claim —
  // none lost, none pointed at both.
  const api = messaging();
  const threadId = await directThread(api, AGENT_A);
  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A, agentRunId: RUN_1, terminalSessionId: TERMINAL_1,
    expectedEndpointGeneration: -1,
  });
  if (!reserved.ok) return;
  await api.activateAgentEndpointClaim(runtimeCtx(), reserved.value.id);

  for (const text of ["one", "two", "three"]) {
    const sent = await api.sendAgentMessage(ctx(), {
      target: { kind: "agent", agentId: AGENT_A },
      threadId: threadId as never, text, clientMessageId: `cmid-${text}`,
    });
    assert.equal(sent.ok, true);
  }

  const moved = await api.transferAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A,
    expectedOldClaimId: reserved.value.id,
    newRunId: RUN_2,
    newTerminalSessionId: TERMINAL_2,
    oldFinalTranscriptWatermark: "pos-9",
    expectedEndpointGeneration: 0,
  });
  assert.equal(moved.ok, true);
  if (!moved.ok) return;

  const inbox = await api.listAgentInbox(human, { agentId: AGENT_A });
  assert.equal(inbox.ok, true);
  if (!inbox.ok) return;
  assert.equal(inbox.value.items.length, 3, "a queued Message was lost in the transfer");
  for (const item of inbox.value.items) {
    assert.equal(item.endpointClaimId, moved.value.id,
      "an accepted Message did not follow the endpoint transfer");
  }
});

test("a terminal-originated Message never routes back into its own endpoint", async () => {
  // §8.2: "Terminal-originated Message creation stores the source endpoint
  // effect atomically so it cannot loop back into the same endpoint." Without
  // this, an Agent's own reply is mirrored into Novakai, dispatched as an
  // inbound Message, typed back into its PTY, mirrored again — forever.
  const api = messaging();
  const threadId = await directThread(api, AGENT_A);
  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A, agentRunId: RUN_1, terminalSessionId: TERMINAL_1,
    expectedEndpointGeneration: -1,
  });
  if (!reserved.ok) return;
  await api.activateAgentEndpointClaim(runtimeCtx(), reserved.value.id);

  const mirrored = await api.commitTerminalOriginatedMessage(transcriptCtx(), {
    bindingId: "transcriptBinding_x" as never,
    agentId: AGENT_A,
    threadId: threadId as never,
    sourceEndpointClaimId: reserved.value.id,
    turn: {
      transcriptLineId: "line-1", bindingId: "transcriptBinding_x" as never,
      sourcePosition: "1", role: "assistant", text: "I finished the task",
      sourceDigest: "d1", providerMetadata: {},
    },
  });
  assert.equal(mirrored.ok, true);
  if (!mirrored.ok) return;
  assert.equal(mirrored.value.state, "committed");
  assert.equal(mirrored.value.inboxItemId, undefined,
    "a terminal-originated Message created an inbox item for its own endpoint");

  const inbox = await api.listAgentInbox(human, { agentId: AGENT_A });
  assert.equal(inbox.ok && inbox.value.items.length, 0);

  // "No inbox item" was the whole of this test, and it exactly matched the
  // implementation shortcut. §24.6 says "origin loopback does not return to the
  // same endpoint" — NO route back, not one route back that happens to be
  // unused. So the Delivery is what has to be checked: a pending Delivery
  // addressed to the origin is pullable, attemptable, and emits delivery
  // effects at whatever wires them next.
  const deliveries = await deliveriesOf(api, mirrored.value.messageId);
  assert.equal(deliveries.length, 0,
    `the mirrored Message carries ${String(deliveries.length)} Delivery(s), and its `
    + "own origin is the recipient — a route straight back into the endpoint it came from");

  // The control: an INBOUND Message to the same Agent does get a Delivery, so
  // the assertion above is about loopback and not about deliveries being off.
  const inbound = await api.sendAgentMessage(ctx(), {
    target: { kind: "agent", agentId: AGENT_A },
    threadId: threadId as never, text: "from Chris", clientMessageId: "cmid-inbound",
  });
  assert.equal(inbound.ok, true);
  if (!inbound.ok) return;
  assert.equal((await deliveriesOf(api, inbound.value.messageId)).length, 1,
    "an inbound Message lost its Delivery too, so the loopback check proves nothing");
});

/** Every Delivery the store actually holds for a Message. */
async function deliveriesOf(
  _api: ReturnType<typeof messaging>, messageId: string,
): Promise<readonly { recipientId: string }[]> {
  const found = await lastStore!.getDeliveries(messageId as never);
  return found.kind === "ok" ? found.value : [];
}

test("the same transcript turn mirrors exactly once, however often it replays", async () => {
  const api = messaging();
  const threadId = await directThread(api, AGENT_A);
  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A, agentRunId: RUN_1, terminalSessionId: TERMINAL_1,
    expectedEndpointGeneration: -1,
  });
  if (!reserved.ok) return;

  const input = {
    bindingId: "transcriptBinding_x" as never,
    agentId: AGENT_A,
    threadId: threadId as never,
    sourceEndpointClaimId: reserved.value.id,
    turn: {
      transcriptLineId: "line-1", bindingId: "transcriptBinding_x" as never,
      sourcePosition: "1", role: "human" as const, text: "do the thing",
      sourceDigest: "d1", providerMetadata: {},
    },
  };
  const first = await api.commitTerminalOriginatedMessage(transcriptCtx(), input);
  const again = await api.commitTerminalOriginatedMessage(transcriptCtx(), input);
  assert.equal(first.ok && again.ok, true);
  if (!first.ok || !again.ok) return;
  assert.equal(again.value.messageId, first.value.messageId);
  assert.equal(again.value.duplicate, true);

  const communications = await api.listAgentCommunications(human, {
    agentIds: [AGENT_A], limit: 50,
  });
  assert.equal(communications.ok, true);
  if (!communications.ok) return;
  assert.equal(communications.value.items.length, 1);
});

test("agent communication is inspectable, and inspecting pins nothing", async () => {
  // Red gate 12 + DEC-B3V4-16, as one executable claim: two Agents converse,
  // Chris can read it, and his sidebar is still empty until he opens it.
  const api = messaging();
  const between = await api.ensureDirectThread(ctx(), {
    between: [{ kind: "agent", agentId: AGENT_A }, { kind: "agent", agentId: AGENT_B }],
  });
  assert.equal(between.ok, true);
  if (!between.ok) return;

  await api.sendAgentMessage(ctx(), {
    target: { kind: "agent", agentId: AGENT_B },
    threadId: between.value.id, text: "status?", clientMessageId: "cmid-1",
  });

  const listed = await api.listAgentCommunications(human, {
    agentIds: [AGENT_A, AGENT_B], limit: 50,
  });
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.value.items.length, 1);
  assert.equal(listed.value.items[0]?.textPreview, "status?");
  assert.deepEqual(listed.value.items[0]?.recipientAgentIds, [AGENT_B]);

  const views = await api.listConversationViews(human);
  assert.equal(views.ok, true);
  if (!views.ok) return;
  assert.equal(views.value.items.length, 0,
    "reading two Agents' conversation pinned it to the sidebar");

  // Now Chris opens it deliberately — and exactly one appears.
  const opened = await api.openConversationView(ctx(), {
    threadId: between.value.id,
    membership: { kind: "group", agentIds: [AGENT_A, AGENT_B] },
  });
  assert.equal(opened.ok, true);
  const after = await api.listConversationViews(human);
  assert.equal(after.ok && after.value.items.length, 1);
  assert.equal(after.ok && after.value.items[0]?.open, true);
});

test("communication items say which direction the Message went", async () => {
  const api = messaging();
  const threadId = await directThread(api, AGENT_A);
  await api.sendAgentMessage(ctx(), {
    target: { kind: "agent", agentId: AGENT_A },
    threadId: threadId as never, text: "from Chris", clientMessageId: "cmid-1",
  });
  const listed = await api.listAgentCommunications(human, { agentIds: [AGENT_A], limit: 50 });
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.value.items[0]?.direction, "to-agent");
  assert.equal(listed.value.items[0]?.senderAgentId, undefined);
});

test("getAgentEndpoint reports claim state, generation and cutoff", async () => {
  const api = messaging();
  const empty = await api.getAgentEndpoint(human, AGENT_A);
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.equal(empty.value.claim, null);
  assert.equal(empty.value.endpointGeneration, -1);

  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A, agentRunId: RUN_1, terminalSessionId: TERMINAL_1,
    expectedEndpointGeneration: -1,
  });
  if (!reserved.ok) return;
  const view = await api.getAgentEndpoint(human, AGENT_A);
  assert.equal(view.ok && view.value.claim?.state, "reserved");
  assert.equal(view.ok && view.value.endpointGeneration, 0);
});

test("a submitted-unconfirmed item is reported, never silently retried", async () => {
  const api = messaging();
  const threadId = await directThread(api, AGENT_A);
  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A, agentRunId: RUN_1, terminalSessionId: TERMINAL_1,
    expectedEndpointGeneration: -1,
  });
  if (!reserved.ok) return;
  await api.activateAgentEndpointClaim(runtimeCtx(), reserved.value.id);
  const sent = await api.sendAgentMessage(ctx(), {
    target: { kind: "agent", agentId: AGENT_A },
    threadId: threadId as never, text: "ping", clientMessageId: "cmid-1",
  });
  if (!sent.ok || sent.value.inboxItemId === undefined) return;

  const claimed = await api.claimNextInboxItem(runtimeCtx(), AGENT_A);
  assert.equal(claimed.ok && claimed.value?.state, "claimed");

  const recorded = await api.recordInboxSubmission(runtimeCtx(), {
    inboxItemId: sent.value.inboxItemId,
    outcome: "submitted-unconfirmed",
  });
  assert.equal(recorded.ok && recorded.value.state, "submitted-unconfirmed");

  // And it stays that way: claiming again must not hand the same uncertain
  // item back out for a second submission.
  const next = await api.claimNextInboxItem(runtimeCtx(), AGENT_A);
  assert.equal(next.ok && next.value, null);
});

test("a claim cannot be reserved against a stale generation", async () => {
  const api = messaging();
  const first = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A, agentRunId: RUN_1, terminalSessionId: TERMINAL_1,
    expectedEndpointGeneration: -1,
  });
  assert.equal(first.ok, true);
  const racing = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT_A, agentRunId: RUN_2, terminalSessionId: TERMINAL_2,
    expectedEndpointGeneration: -1,
  });
  assert.equal(racing.ok, false);
  if (racing.ok) return;
  assert.equal(racing.error.code, "EndpointClaimConflict");
});

test("an unknown claim id is a typed refusal, not a crash", async () => {
  const api = messaging();
  const activated = await api.activateAgentEndpointClaim(
    runtimeCtx(), "agentEndpoint_nope" as AgentEndpointClaimId,
  );
  assert.equal(activated.ok, false);
  if (activated.ok) return;
  assert.equal(activated.error.code, "EndpointClaimConflict");
});
