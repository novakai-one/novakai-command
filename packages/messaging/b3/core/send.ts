/**
 * The two send directions — §12.5's `sendAgentMessage` and §8.2's mirror.
 *
 * They are one module because they are one rule seen from two sides: a Message
 * addressed to an Agent commits BEFORE an endpoint is chosen, and a Message
 * mirrored FROM an endpoint never creates an inbox item at all. The first is
 * how a continuation loses nothing; the second is how an Agent's own words do
 * not get typed back into its own terminal.
 */

import {
  b3err, b3fail, b3ok, mintAgentInboxItemId, nowIsoUtc,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
} from "@novakai/foundation/contract";
import type { PersonId, ThreadId } from "../../public/contract/index.js";
import type { ClockIds } from "../../seams/clock.js";
import type { MessagingStore } from "../../seams/store.js";
import type {
  CommitTerminalOriginatedMessageInput, MessageAcceptance, SendAgentMessageInput,
} from "../contract/api.js";
import type { AgentId } from "../contract/records.js";
import { buildAcceptance } from "./acceptance.js";
import { agentPersonId } from "./identity.js";
import {
  ORIGIN_BINDING_FIELD, ORIGIN_ENDPOINT_FIELD, ORIGIN_LINE_FIELD,
} from "./mirror-fields.js";
import { ensureDirectThread, storeError } from "./threads.js";

export interface SendDeps {
  readonly store: MessagingStore;
  readonly clock: ClockIds;
}

/**
 * The Messaging identity of whoever is calling.
 *
 * A human principal becomes a Person; an Agent Run becomes the Agent it
 * belongs to, resolved through the endpoint claims rather than from anything
 * in the request (red gate 5).
 */
export async function senderFor(
  store: MessagingStore, principal: AuthenticatedPrincipal,
): Promise<PersonId> {
  if (principal.kind === "agent-run" && principal.agentRunId !== undefined) {
    const agentId = await agentOfRun(store, principal.agentRunId);
    if (agentId !== null) return agentPersonId(agentId);
  }
  // A principal that is ALREADY a Messaging identity is used as it stands.
  // Wrapping it again produced `person_person-chris` in the first real CLI
  // run — a second identity for one human, and every Thread keyed on it would
  // have been a Thread Chris could not find.
  const given = String(principal.id);
  if (given.startsWith("person_")) return given as PersonId;
  return `person_${given.replace(/[^A-Za-z0-9-]/g, "-")}` as PersonId;
}

/** The endpoint claim is the durable join from a Run back to its Agent. */
export async function agentOfRun(
  store: MessagingStore, agentRunId: string,
): Promise<AgentId | null> {
  const claims = await store.listAllAgentEndpointClaims();
  if (claims.kind !== "ok") return null;
  return claims.value.find((claim) => claim.agentRunId === agentRunId)?.agentId ?? null;
}

/**
 * The conversation this Message joins: the one named, or the direct Thread
 * between the sender and the Agent.
 *
 * §12.5 required a ThreadId and §16.2 published nothing that mints one, so a
 * client holding the complete contract had exactly one possible outcome from
 * every send: `ValidationFailed: threadId must be a thread_ id`. The CLI worked
 * only because it resolved the same direct Thread privately before calling —
 * which means the rule was already decided, just not available to anyone else.
 *
 * A Message from an Agent to itself has no direct Thread (a direct Thread needs
 * two participants), and that refusal is left to `ensureDirectThread` rather
 * than being pre-empted here: one rule, one place.
 */
async function threadFor(
  store: MessagingStore, senderId: PersonId, agentId: AgentId, named?: ThreadId,
): Promise<B3Result<ThreadId>> {
  if (named !== undefined) return b3ok(named);
  // `kind: "human"` here means only "this participant is already a PersonId" —
  // an Agent sender arrives as `person_agent_<uuid>`, which is what its side of
  // a direct Thread is either way.
  const resolved = await ensureDirectThread(store, {
    between: [
      { kind: "human", personId: senderId },
      { kind: "agent", agentId },
    ],
  });
  if (!resolved.ok) return resolved;
  return b3ok(resolved.value.id);
}

/**
 * Where an already-accepted Message has actually got to, in the four words
 * `MessageAcceptance` is allowed to say (§12.5).
 *
 * §8.1's inbox item has six states and the acceptance vocabulary has four, so
 * only the two that appear in both are reported by name. `claimed` is still
 * queued as far as the sender is concerned — nothing has been typed yet — and
 * `transcript-observed` and `failed` have no acceptance word at all; the
 * capability does not invent one for them here.
 */
async function acceptanceStateOf(
  store: MessagingStore, agentId: AgentId, messageId: string,
): Promise<MessageAcceptance["state"]> {
  const inbox = await store.listAgentInbox(agentId);
  if (inbox.kind !== "ok") return "queued-for-agent";
  const item = inbox.value.find((entry) => entry.messageId === messageId);
  if (item?.state === "submitted-confirmed") return "submitted-confirmed";
  if (item?.state === "submitted-unconfirmed") return "submitted-unconfirmed";
  return "queued-for-agent";
}

/**
 * One Agent-addressed acceptance. DEC-B3V4-32: no endpoint is consulted, so an
 * Agent with no live Run — or one halfway through a continuation — still
 * accepts Messages into its durable inbox.
 */
async function acceptanceFor(
  deps: SendDeps, senderId: PersonId, input: SendAgentMessageInput, agentId: AgentId,
  clientMessageId: string, requestedRunId?: string,
): Promise<B3Result<MessageAcceptance>> {
  const { store, clock } = deps;
  const threadId = await threadFor(store, senderId, agentId, input.threadId);
  if (!threadId.ok) return threadId;
  const inboxItemId = mintAgentInboxItemId(agentId, clientMessageId) as string;
  const built = buildAcceptance(clock, {
    senderId,
    recipients: [agentPersonId(agentId)],
    threadId: threadId.value,
    text: input.text,
    clientMessageId,
    ...(input.screenContext === undefined ? {} : { screenContext: input.screenContext }),
    inboxFor: {
      agentId, inboxItemId,
      ...(requestedRunId === undefined ? {} : { requestedRunId }),
    },
  });
  const committed = await store.commitAcceptance(built);
  if (committed.kind === "failed") return b3fail(storeError(committed.error));
  if (committed.kind === "conflict") {
    return b3fail(b3err("IdempotencyConflict",
      `clientMessageId ${clientMessageId} was already used for a different Message`,
      {
        receiptId: clientMessageId,
        originalHash: committed.error.originalMessageId,
        receivedHash: "different",
      }, false));
  }
  if (committed.kind === "duplicate") {
    return b3ok({
      messageId: committed.original.messageId,
      inboxItemId,
      acceptedAt: committed.original.createdAt,
      // §12.5's idempotent replay returns the SAME Message — and the state it
      // has reached since, not the word it was born with. `queued-for-agent`
      // on a Message already typed into the terminal is how `nvk agent message`
      // came to have three unreachable branches in its own state table.
      state: await acceptanceStateOf(store, agentId, committed.original.messageId),
      threadId: committed.original.threadId,
      duplicate: true,
    });
  }
  return b3ok({
    messageId: committed.messageId,
    inboxItemId,
    acceptedAt: nowIsoUtc(),
    state: "queued-for-agent",
    threadId: committed.threadId,
    duplicate: false,
  });
}

export async function sendAgentMessage(
  deps: SendDeps, context: CommandContext, input: SendAgentMessageInput,
): Promise<B3Result<MessageAcceptance>> {
  const { store } = deps;
  const senderId = await senderFor(store, context.principal);
  const clientMessageId = input.clientMessageId ?? String(context.clientOpId);

  if (input.target.kind === "agent") {
    // DEC-B3V4-32: no endpoint is consulted. An Agent with no live Run,
    // or one halfway through a continuation, still accepts Messages.
    return acceptanceFor(deps, senderId, input, input.target.agentId, clientMessageId);
  }

  const { agentRunId } = input.target;
  const agentId = await agentOfRun(store, agentRunId);
  if (agentId === null) {
    return b3fail(b3err("UnknownAgentRun",
      `no endpoint has ever been claimed for ${agentRunId}`,
      { agentRunId }, false));
  }
  // An exact-Run send is a promise about WHICH provider context reads it.
  // Once that Run's endpoint has a cutoff the promise cannot be kept, and
  // §8.1 says fail rather than quietly redirect to the successor.
  const claims = await store.listAgentEndpointClaims(agentId);
  if (claims.kind === "error") return b3fail(storeError(claims.error));
  const forRun = claims.value.find((claim) => claim.agentRunId === agentRunId);
  if (forRun?.cutoffMessageSequence !== undefined) {
    return b3fail(b3err("ExactRunEndpointClosed",
      `Run ${agentRunId} stopped accepting Messages at sequence ${forRun.cutoffMessageSequence}`,
      { agentRunId, cutoffSequence: forRun.cutoffMessageSequence }, false));
  }
  return acceptanceFor(deps, senderId, input, agentId, clientMessageId, agentRunId);
}

// --- §8.2 the terminal direction ---------------------------------------------

export async function commitTerminalOriginatedMessage(
  deps: SendDeps, input: CommitTerminalOriginatedMessageInput,
): Promise<B3Result<MessageAcceptance>> {
  const { store, clock } = deps;
  // The Agent is the SENDER when it spoke, and the sender when a human
  // typed into its terminal too: the Message originated at that endpoint
  // either way, and attributing a human's typing to the human would
  // create a second identity for one conversation.
  const senderId = agentPersonId(input.agentId);
  // One Message per transcript line, forever. A replay of the same line
  // after any crash point is the same clientMessageId, so the store's
  // idempotency reservation returns the original rather than a twin.
  const clientMessageId = `mirror:${input.turn.transcriptLineId}`;
  const built = buildAcceptance(clock, {
    senderId,
    // The Agent is on the recipient snapshot because it IS a participant in
    // this conversation — dropping it there would make the Message look like
    // it belonged to nobody. What it does not get is a Delivery: `originIdentity`
    // means "this identity is where the Message came from", and no Delivery,
    // attempt or effect is ever built for it. §24.6's loopback rule, structural.
    recipients: [senderId],
    originIdentity: senderId,
    threadId: input.threadId,
    text: input.turn.text,
    clientMessageId,
  });
  const withOrigin = {
    ...built,
    message: {
      ...built.message,
      body: {
        ...built.message.body,
        fields: {
          [ORIGIN_BINDING_FIELD]: input.bindingId,
          [ORIGIN_ENDPOINT_FIELD]: input.sourceEndpointClaimId,
          [ORIGIN_LINE_FIELD]: input.turn.transcriptLineId,
        },
      },
    },
  };
  const committed = await store.commitAcceptance(withOrigin);
  if (committed.kind === "failed") return b3fail(storeError(committed.error));
  if (committed.kind === "conflict") {
    return b3fail(b3err("ValidationFailed",
      `transcript line ${input.turn.transcriptLineId} already mirrored with different content`,
      { issues: [{ path: "turn.text", message: "conflicts with the mirrored Message" }] },
      false));
  }
  if (committed.kind === "duplicate") {
    return b3ok({
      messageId: committed.original.messageId,
      acceptedAt: committed.original.createdAt,
      state: "committed" as const,
      threadId: committed.original.threadId,
      duplicate: true,
    });
  }
  return b3ok({
    messageId: committed.messageId,
    acceptedAt: nowIsoUtc(),
    state: "committed" as const,
    threadId: committed.threadId,
    duplicate: false,
  });

}
