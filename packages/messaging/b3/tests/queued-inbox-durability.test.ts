/**
 * §13.6: "Agent-addressed Messages commit and queue throughout."
 *
 * Throughout means whatever the target Run's lifecycle is doing. Only an
 * exact-old-Run Message fails after the draining cutoff; a Message addressed to
 * the AGENT is owed a durable queued item either way, because §13.8 says the
 * recipient is an Agent identity and Run replacement does not strand it.
 *
 * The item was durable already — inside the acceptance operation's
 * `agentInboxItems`. What did not exist was any record of `queued` in the
 * operation kind that records every OTHER state the same item reaches. A reader
 * that follows one inbox item through `agent-inbox-transition` — the durable
 * log, not the in-process projection — saw an item appear at `claimed` with no
 * queued record before it, and, for an Agent whose Run is gone, saw nothing at
 * all: `claimed` never happens, so the item's own operation kind was never
 * written and the acceptance referenced an inbox the log could not corroborate.
 *
 * The scenario here is the one the store actually held (hold-out run 9DCAA5BC):
 * an Agent whose only Run is `interrupted` / `runtime-reconciled-missing`, its
 * endpoint claim `draining` with a cutoff, and a human-originated Message
 * addressed to the Agent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openFoundationMessagingStore } from "../adapters/store-foundation.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import { composeAgentMessaging } from "../core/compose.js";
import type { AgentMessagingContract } from "../contract/api.js";
import type { AgentId, AgentRunId } from "../contract/records.js";
import type { MessagingStore } from "../../seams/store.js";
import type { AuthenticatedPrincipal, SystemCommandContext } from "@novakai/foundation/contract";

const AGENT = "agent_072264fb-a4be-4a13-9d62-f597662685a5" as AgentId;
const RUN = "agentRun_019fc432-3d40-75cb-b673-f7c79650c4d2" as AgentRunId;
const TERMINAL = "terminalSession_019fc432-3d64-7296-838f-0da5fe936fe0";

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

interface Rig {
  readonly api: AgentMessagingContract;
  readonly store: MessagingStore;
  readonly root: string;
}

async function rig(seed: string): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), "nvk-b3c-queued-"));
  const clock = createSeededClock({ seed });
  const store = await openFoundationMessagingStore(clock, {
    root, dataRoot: path.join(root, "stores"),
  });
  return { api: composeAgentMessaging({ store, clock }), store, root };
}

/**
 * The durable operation kinds this Message is named in — the log as an outside
 * reader finds it, not the in-process projection that would agree with itself.
 */
function durableOpsFor(root: string, messageId: string): string[] {
  const file = path.join(root, "stores", "messagingStoreOps.jsonl");
  const kinds: string[] = [];
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    if (line.length === 0) continue;
    const record = JSON.parse(line) as { payload: { storeOp: { op: string } } };
    if (!JSON.stringify(record.payload.storeOp).includes(messageId)) continue;
    if (!kinds.includes(record.payload.storeOp.op)) kinds.push(record.payload.storeOp.op);
  }
  return kinds.sort();
}

/** The Agent's shift is over: the endpoint drained behind a cutoff. */
async function drainedShift(api: AgentMessagingContract): Promise<void> {
  const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
    agentId: AGENT, agentRunId: RUN,
    terminalSessionId: TERMINAL as never, expectedEndpointGeneration: -1,
  });
  if (!reserved.ok) throw new Error(reserved.error.code);
  const active = await api.activateAgentEndpointClaim(runtimeCtx(), reserved.value.id);
  if (!active.ok) throw new Error(active.error.code);
  const drained = await api.drainAgentEndpointClaim(runtimeCtx(), reserved.value.id);
  if (!drained.ok) throw new Error(drained.error.code);
  assert.equal(drained.value.state, "draining");
}

test("a Message queued for an Agent whose Run is gone is queued in the durable log", async () => {
  const { api, root } = await rig("b3c-r5-d2");
  try {
    await drainedShift(api);

    const sent = await api.sendAgentMessage(humanCtx(), {
      target: { kind: "agent", agentId: AGENT },
      text: "Please ignore this line. NVK-R5-D2",
    });
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    assert.equal(sent.value.state, "queued-for-agent");
    assert.notEqual(sent.value.inboxItemId, undefined);

    assert.deepEqual(
      durableOpsFor(root, sent.value.messageId),
      ["acceptance", "agent-inbox-transition"],
      "the acceptance names an inbox item the durable log never records as queued",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the queued record survives a reopen and still holds one item at queued", async () => {
  const { api, store, root } = await rig("b3c-r5-d2-replay");
  try {
    await drainedShift(api);
    const sent = await api.sendAgentMessage(humanCtx(), {
      target: { kind: "agent", agentId: AGENT },
      text: "Please ignore this line. NVK-R5-D2-REPLAY",
    });
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    await store.close();

    const reopened = await openFoundationMessagingStore(
      createSeededClock({ seed: "b3c-r5-d2-replay-2" }),
      { root, dataRoot: path.join(root, "stores") },
    );
    const inbox = await reopened.listAgentInbox(AGENT);
    assert.equal(inbox.kind, "ok");
    if (inbox.kind !== "ok") return;
    // One item, not two: the acceptance and the queued record are the same
    // item, so a replay of both must not leave a duplicate behind.
    assert.equal(inbox.value.length, 1);
    assert.equal(inbox.value[0]?.state, "queued");
    assert.equal(inbox.value[0]?.messageId, sent.value.messageId);
    await reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a duplicate send does not re-queue an item the terminal has already taken", async () => {
  const { api, root } = await rig("b3c-r5-d2-dup");
  try {
    // A live shift this time: the item can be claimed, which is exactly the
    // state an idempotent replay must not walk backwards over.
    const reserved = await api.reserveAgentEndpointClaim(runtimeCtx(), {
      agentId: AGENT, agentRunId: RUN,
      terminalSessionId: TERMINAL as never, expectedEndpointGeneration: -1,
    });
    if (!reserved.ok) throw new Error(reserved.error.code);
    const active = await api.activateAgentEndpointClaim(runtimeCtx(), reserved.value.id);
    if (!active.ok) throw new Error(active.error.code);

    const first = await api.sendAgentMessage(humanCtx(), {
      target: { kind: "agent", agentId: AGENT },
      text: "Please ignore this line. NVK-R5-D2-DUP",
      clientMessageId: "op_r5_dup",
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const claimed = await api.claimNextInboxItem(runtimeCtx(), AGENT);
    assert.equal(claimed.ok, true);
    if (!claimed.ok || claimed.value === null) throw new Error("nothing to claim");
    assert.equal(claimed.value.state, "claimed");

    const again = await api.sendAgentMessage(humanCtx(), {
      target: { kind: "agent", agentId: AGENT },
      text: "Please ignore this line. NVK-R5-D2-DUP",
      clientMessageId: "op_r5_dup",
    });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.value.duplicate, true);

    const inbox = await api.listAgentInbox(human, { agentId: AGENT });
    assert.equal(inbox.ok, true);
    if (!inbox.ok) return;
    assert.equal(inbox.value.items.length, 1);
    assert.equal(inbox.value.items[0]?.state, "claimed");
    assert.deepEqual(
      durableOpsFor(root, first.value.messageId),
      ["acceptance", "agent-inbox-transition"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Message with no Agent recipient writes no inbox record at all", async () => {
  const { api, root } = await rig("b3c-r5-d2-mirror");
  try {
    await drainedShift(api);
    const thread = await api.ensureDirectThread(humanCtx(), {
      between: [
        { kind: "human", personId: "person_chris" as never },
        { kind: "agent", agentId: AGENT },
      ],
    });
    assert.equal(thread.ok, true);
    if (!thread.ok) return;

    // §8.2's mirror: the Agent's own turn. No inbox item is built for it, and
    // the queued record must not invent one — that would type an Agent's own
    // words back into its terminal.
    const mirrored = await api.commitTerminalOriginatedMessage(
      {
        principal: { id: "sys_transcript", kind: "system", verifiedScopes: [] },
        clientOpId: "op_mirror_r5" as never,
        traceId: "trace_mirror_r5" as never,
        contractVersion: 1,
      },
      {
        agentId: AGENT,
        threadId: thread.value.id,
        bindingId: "transcriptBinding_r5" as never,
        sourceEndpointClaimId: "agentEndpoint_r5" as never,
        turn: {
          transcriptLineId: "transcriptLine_r5",
          bindingId: "transcriptBinding_r5" as never,
          sourcePosition: "0000000001",
          role: "assistant",
          text: "the Agent said this",
          sourceDigest: "r5-digest",
          providerMetadata: {},
        },
      },
    );
    assert.equal(mirrored.ok, true);
    if (!mirrored.ok) return;
    assert.deepEqual(durableOpsFor(root, mirrored.value.messageId), ["acceptance"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
