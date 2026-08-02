/**
 * The Agent endpoint lifecycle — §8.1, §13.6, DEC-B3V4-32.
 *
 * reserve → activate → (drain) → transfer. Four operations over one CAS'd
 * generation, which is the only thing standing between a continuation and two
 * live endpoints for one Agent.
 *
 * The transfer is where §13.6's ordering is enforced: the old claim closes and
 * the new one opens in ONE store operation, and every queued inbox item is
 * re-pointed inside it. There is no instant at which a queued Message belongs
 * to both endpoints or to neither.
 */

import {
  b3err, b3fail, b3ok, mintAgentEndpointClaimId, nowIsoUtc, type B3Result,
} from "@novakai/foundation/contract";
import type { MessagingStore } from "../../seams/store.js";
import type {
  ReserveAgentEndpointInput, TransferAgentEndpointInput,
} from "../contract/api.js";
import type {
  AgentEndpointClaim, AgentEndpointClaimId, AgentEndpointState, AgentId, AgentInboxItem,
  MessagingStoreOpId,
} from "../contract/records.js";
import { storeError } from "./threads.js";

const claimConflict = (
  message: string, details: Readonly<Record<string, unknown>>,
): ReturnType<typeof b3err> => b3err("EndpointClaimConflict", message, details, true);

function draftClaim(
  input: ReserveAgentEndpointInput, generation: number, state: AgentEndpointState,
): AgentEndpointClaim {
  return {
    id: mintAgentEndpointClaimId(input.agentId, generation) as string as AgentEndpointClaimId,
    kind: "agentEndpointClaim",
    schemaVersion: 1,
    entityRevision: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: "private",
    createdBy: "sys_agent_runtime",
    lastStoreOpId: "messagingStoreOp_pending" as MessagingStoreOpId,
    agentId: input.agentId,
    agentRunId: input.agentRunId,
    terminalSessionId: input.terminalSessionId,
    endpointGeneration: generation,
    state,
  };
}

export async function reserveAgentEndpointClaim(
  store: MessagingStore, input: ReserveAgentEndpointInput,
): Promise<B3Result<AgentEndpointClaim>> {
  const generation = input.expectedEndpointGeneration + 1;
  const committed = await store.commitAgentEndpointClaim({
    claim: draftClaim(input, generation, "reserved"),
    expectedEndpointGeneration: input.expectedEndpointGeneration,
  });
  if (committed.kind === "error") {
    if (committed.error.name === "RevisionConflict") {
      return b3fail(claimConflict(
        `endpoint generation moved: expected ${committed.error.expected}, actual ${committed.error.actual}`,
        {
          agentId: input.agentId,
          expectedGeneration: committed.error.expected,
          actualGeneration: committed.error.actual,
        },
      ));
    }
    return b3fail(storeError(committed.error));
  }
  return b3ok(committed.value);
}

export async function activateAgentEndpointClaim(
  store: MessagingStore, claimId: AgentEndpointClaimId,
): Promise<B3Result<AgentEndpointClaim>> {
  const found = await findClaim(store, claimId);
  if (found === null) {
    return b3fail(claimConflict(`no endpoint claim ${claimId}`, { claimId }));
  }
  if (found.state === "closed") {
    return b3fail(claimConflict(
      `endpoint claim ${claimId} is closed and cannot be activated`,
      { claimId, state: found.state },
    ));
  }
  const committed = await store.commitAgentEndpointClaim({
    claim: { ...found, state: "active" },
    expectedEndpointGeneration: found.endpointGeneration,
  });
  if (committed.kind === "error") return b3fail(storeError(committed.error));
  return b3ok(committed.value);
}

/**
 * §13.6 row 2 — "old endpoint draining".
 *
 * A separate operation from the transfer because §13.6 makes it a separate
 * step: the old endpoint stops accepting new work while the replacement is
 * still being provisioned, and the transfer that follows may be seconds later
 * or (on a failed continuation) never. A claim that could only ever be drained
 * as part of a successful transfer would leave nothing fenced in between.
 *
 * Idempotent: draining an already-draining claim returns it unchanged, because
 * a resumed continuation must not be blocked by its own earlier progress.
 */
export async function drainAgentEndpointClaim(
  store: MessagingStore, claimId: AgentEndpointClaimId,
): Promise<B3Result<AgentEndpointClaim>> {
  const found = await findClaim(store, claimId);
  if (found === null) {
    return b3fail(claimConflict(`no endpoint claim ${claimId}`, { claimId }));
  }
  if (found.state === "draining") return b3ok(found);
  if (found.state === "closed") {
    return b3fail(claimConflict(
      `endpoint claim ${claimId} is already closed`, { claimId, state: found.state },
    ));
  }
  const committed = await store.commitAgentEndpointClaim({
    claim: { ...found, state: "draining" },
    expectedEndpointGeneration: found.endpointGeneration,
  });
  if (committed.kind === "error") return b3fail(storeError(committed.error));
  return b3ok(committed.value);
}

/**
 * §13.6, in the order the spec writes it: drain the old endpoint with a cutoff,
 * then hand every queued item to the new one, atomically.
 *
 * The cutoff is set from the CURRENT last accepted sequence for the Agent, so
 * an exact-old-Run send that arrives after this point fails
 * `ExactRunEndpointClosed` while an Agent-addressed send keeps queuing.
 */
export async function transferAgentEndpointClaim(
  store: MessagingStore, input: TransferAgentEndpointInput,
): Promise<B3Result<AgentEndpointClaim>> {
  const previous = await findClaim(store, input.expectedOldClaimId);
  if (previous === null) {
    return b3fail(claimConflict(
      `no endpoint claim ${input.expectedOldClaimId} to transfer from`,
      { claimId: input.expectedOldClaimId },
    ));
  }
  if (previous.endpointGeneration !== input.expectedEndpointGeneration) {
    return b3fail(claimConflict(
      "the endpoint moved before this transfer could start",
      {
        agentId: input.agentId,
        expectedGeneration: input.expectedEndpointGeneration,
        actualGeneration: previous.endpointGeneration,
      },
    ));
  }

  const inbox = await store.listAgentInbox(input.agentId);
  if (inbox.kind === "error") return b3fail(storeError(inbox.error));
  const cutoff = inbox.value.reduce(
    (highest, item) => Math.max(highest, item.acceptedSequence), 0,
  );

  const generation = previous.endpointGeneration + 1;
  const closedOld: AgentEndpointClaim = {
    ...previous,
    state: "closed",
    cutoffMessageSequence: cutoff,
    finalTranscriptWatermark: input.oldFinalTranscriptWatermark,
  };
  const next: AgentEndpointClaim = {
    ...draftClaim({
      agentId: input.agentId,
      agentRunId: input.newRunId,
      terminalSessionId: input.newTerminalSessionId,
      expectedEndpointGeneration: previous.endpointGeneration,
    }, generation, "active"),
  };

  // Only items that can still be delivered move. A submitted-unconfirmed item
  // is left where it is on purpose — the store refuses to move it, and asking
  // it to would fail the whole transfer (§13.6).
  const movable = inbox.value.filter((item) => item.state === "queued" || item.state === "claimed");
  const moved: AgentInboxItem[] = movable.map((item) => ({
    ...item, state: "queued", endpointClaimId: next.id,
  }));

  const transferred = await store.transferAgentEndpoint({
    oldClaim: closedOld,
    newClaim: next,
    inboxItems: moved,
    expectedEndpointGeneration: previous.endpointGeneration,
  });
  if (transferred.kind === "error") return b3fail(storeError(transferred.error));
  return b3ok(transferred.value.claim);
}

export async function findClaim(
  store: MessagingStore, claimId: AgentEndpointClaimId,
): Promise<AgentEndpointClaim | null> {
  const found = await store.getAgentEndpointClaim(claimId);
  return found.kind === "ok" ? found.value : null;
}
