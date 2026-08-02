/**
 * §19.2's inspection reads a CONVERSATION, and a conversation has an order —
 * plus two declared filters that were accepted and ignored.
 *
 *   - `runIds` is on `ListAgentCommunicationsInput` and nothing reads it. A
 *     caller asking "what did THIS shift say" got every shift the Agent ever
 *     had, with no signal that the question was dropped.
 *   - `cursor` likewise: paging past the first page silently restarted it.
 *   - rows sorted by `messageId`, which is a random UUID. The probe read a
 *     two-Agent exchange back in an order neither Agent spoke it in.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "../../adapters/store-memory.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import { composeAgentMessaging } from "../core/compose.js";
import type { AgentMessagingContract } from "../contract/api.js";
import type { AgentId, AgentRunId } from "../contract/records.js";
import type { AuthenticatedPrincipal, SystemCommandContext } from "@novakai/foundation/contract";

const AGENT = "agent_11111111-1111-4111-8111-111111111111" as AgentId;
const RUN_1 = "agentRun_019fc000-0000-7000-8000-000000000001" as AgentRunId;
const RUN_2 = "agentRun_019fc000-0000-7000-8000-000000000002" as AgentRunId;
const TERMINAL_1 = "terminalSession_019fc000-0000-7000-8000-000000000001";
const TERMINAL_2 = "terminalSession_019fc000-0000-7000-8000-000000000002";

const human: AuthenticatedPrincipal = {
  id: "person_chris" as never, kind: "human", verifiedScopes: ["messaging.read"],
};

const humanCtx = { principal: human, clientOpId: "op_1" as never, contractVersion: 1 as const };

const runtimeCtx = (): SystemCommandContext<"sys_agent_runtime"> => ({
  principal: { id: "sys_agent_runtime", kind: "system", verifiedScopes: [] },
  clientOpId: `op_${String(Math.random()).slice(2)}` as never,
  contractVersion: 1,
});

/**
 * A clock whose ids carry no order — which is what production's do.
 *
 * `createSystemClock` mints "128 bits of randomness, hex-encoded", so sorting
 * rows by `messageId` sorts them by nothing. A seeded clock hides that: its
 * counter ascends with time, so id order and time order agree and a read sorted
 * the wrong way still looks right. This one makes them DISAGREE — time ascends
 * per mint, message ids descend — so a read that sorts by id reads the
 * conversation backwards, exactly as the probe found it.
 */
function scrambledClock(seed: string): ReturnType<typeof createSeededClock> {
  const inner = createSeededClock({ seed });
  let remaining = 900_000;
  return {
    ...inner,
    now: () => inner.now(),
    newId(kind) {
      if (kind === "message") {
        // Descending, zero-padded so string order is numeric order.
        remaining -= 1;
        inner.advance(1_000);
        return `message_${String(remaining).padStart(7, "0")}` as never;
      }
      return inner.newId(kind);
    },
  };
}

function messaging(): AgentMessagingContract {
  const clock = scrambledClock("b3c-filters");
  return composeAgentMessaging({ store: createMemoryStore(clock), clock });
}

/** Send `count` Messages, each attributed to the Run whose endpoint is live. */
async function exchange(api: AgentMessagingContract): Promise<readonly string[]> {
  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT, agentRunId: RUN_1,
    terminalSessionId: TERMINAL_1 as never, expectedEndpointGeneration: -1,
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) throw new Error("reserve failed");
  await api.activateAgentEndpointClaim(runtimeCtx(), reserved.value.id);

  const ids: string[] = [];
  for (const text of ["first", "second", "third"]) {
    const sent = await api.sendAgentMessage(humanCtx, {
      target: { kind: "exact-run", agentRunId: RUN_1 },
      text, clientMessageId: `cmid-${text}`,
    });
    assert.equal(sent.ok, true, sent.ok ? "" : sent.error.message);
    if (!sent.ok) throw new Error("send failed");
    ids.push(sent.value.messageId);
  }

  // A second shift, so `runIds` has something to discriminate.
  const moved = await api.transferAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT, expectedOldClaimId: reserved.value.id,
    newRunId: RUN_2, newTerminalSessionId: TERMINAL_2 as never,
    oldFinalTranscriptWatermark: "pos-1", expectedEndpointGeneration: 0,
  });
  assert.equal(moved.ok, true, moved.ok ? "" : moved.error.message);
  const later = await api.sendAgentMessage(humanCtx, {
    target: { kind: "exact-run", agentRunId: RUN_2 },
    text: "fourth", clientMessageId: "cmid-fourth",
  });
  assert.equal(later.ok, true, later.ok ? "" : later.error.message);
  if (!later.ok) throw new Error("send failed");
  ids.push(later.value.messageId);
  return ids;
}

test("communications read back in the order they occurred, not by messageId", async () => {
  const api = messaging();
  await exchange(api);

  const page = await api.listAgentCommunications(human, { agentIds: [AGENT], limit: 100 });
  assert.equal(page.ok, true);
  if (!page.ok) return;

  const texts = page.value.items.map((item) => item.textPreview);
  assert.deepEqual(texts, ["first", "second", "third", "fourth"],
    "the conversation reads back in an order nobody spoke it in");

  const occurred = page.value.items.map((item) => item.occurredAt);
  const sorted = [...occurred].sort();
  assert.deepEqual(occurred, sorted, "occurredAt is not non-decreasing across the page");
});

test("runIds narrows the read to the shifts asked about", async () => {
  const api = messaging();
  await exchange(api);

  // RUN_1 is the discriminating question. "fourth" was sent after the transfer
  // and only ever belonged to RUN_2, so a read that still returns it is a read
  // that dropped the filter.
  const first = await api.listAgentCommunications(human, {
    agentIds: [AGENT], runIds: [RUN_1], limit: 100,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.value.items.map((item) => item.textPreview),
    ["first", "second", "third"],
    "runIds was accepted and ignored: the read returned a shift nobody asked about");

  // RUN_2 legitimately matches all four: §13.6's transfer MOVES queued items
  // onto the new claim, so the three that followed it relate to both Runs.
  // That is the contract, not a leak — `relatedRunIds` says so on every row.
  const second = await api.listAgentCommunications(human, {
    agentIds: [AGENT], runIds: [RUN_2], limit: 100,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.value.items.map((item) => item.textPreview),
    ["first", "second", "third", "fourth"]);

  // A Run that never touched this Agent narrows to nothing — the proof that the
  // two results above are the filter working, not the filter passing everything.
  const stranger = await api.listAgentCommunications(human, {
    agentIds: [AGENT],
    runIds: ["agentRun_019fc000-0000-7000-8000-00000000009f" as AgentRunId],
    limit: 100,
  });
  assert.equal(stranger.ok, true);
  if (!stranger.ok) return;
  assert.deepEqual(stranger.value.items, []);
});

test("a cursor continues the read rather than restarting it", async () => {
  const api = messaging();
  await exchange(api);

  const firstPage = await api.listAgentCommunications(human, { agentIds: [AGENT], limit: 2 });
  assert.equal(firstPage.ok, true);
  if (!firstPage.ok) return;
  assert.equal(firstPage.value.items.length, 2);
  const last = firstPage.value.items[1]!;

  const next = await api.listAgentCommunications(human, {
    agentIds: [AGENT], cursor: last.messageId as never, limit: 100,
  });
  assert.equal(next.ok, true);
  if (!next.ok) return;
  assert.deepEqual(next.value.items.map((item) => item.textPreview), ["third", "fourth"],
    "the cursor was accepted and ignored: paging silently restarted at the top");
});
