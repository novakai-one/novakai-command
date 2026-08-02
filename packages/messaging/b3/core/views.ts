/**
 * The inspection surfaces — §19.2, red gate 12, DEC-B3V4-16.
 *
 * "An Agent and its communications exist even when no Conversation is pinned
 * in Chris's Messages sidebar." That sentence is only true if reading is a
 * pure read. Everything here reads; nothing here creates a conversationView,
 * and the capability test asserts the count stays at zero across a whole
 * two-Agent exchange.
 */

import { b3ok, type B3Result, type Page } from "@novakai/foundation/contract";
import type { Message, PersonId, ThreadId } from "../../public/contract/index.js";
import type { MessagingStore } from "../../seams/store.js";
import type { ListAgentCommunicationsInput } from "../contract/api.js";
import type {
  AgentCommunicationDirection, AgentCommunicationItem, AgentEndpointClaimId, AgentId,
  AgentInboxItem, AgentInboxItemState, AgentRunId,
} from "../contract/records.js";
import { previewOf } from "../contract/records.js";
import { agentIdOf, agentPersonId } from "./identity.js";
import { ORIGIN_BINDING_FIELD } from "./mirror-fields.js";

/**
 * Both derived facts on a communication row — where a Message was mirrored
 * from, and which Runs it touched — come from DURABLE state, never from a
 * process-memory index. An in-memory map would look identical until the first
 * restart, at which point loopback protection and Run attribution would
 * silently disappear from every historical Message.
 */
export interface CommunicationContext {
  readonly store: MessagingStore;
}

function directionOf(
  message: Message, subjects: ReadonlySet<PersonId>,
): AgentCommunicationDirection {
  const senderIsSubject = subjects.has(message.senderId);
  const senderIsAgent = agentIdOf(message.senderId) !== null;
  if (senderIsSubject && senderIsAgent) return "from-agent";
  if (senderIsAgent) return "between-agents";
  return "to-agent";
}

/**
 * Every Message involving the named Agents, newest last, with enough on each
 * row to be read without a second fetch: who sent it, which way it went, and
 * what it said.
 */
export async function listAgentCommunications(
  context: CommunicationContext, input: ListAgentCommunicationsInput,
): Promise<B3Result<Page<AgentCommunicationItem>>> {
  const subjects = new Set(input.agentIds.map(agentPersonId));
  const threads = await threadIdsFor(
    context.store, subjects, input.agentIds, input.threadId,
  );
  const items: AgentCommunicationItem[] = [];

  for (const threadId of threads) {
    const page = await context.store.getMessages(threadId, { limit: 1_000 });
    if (page.kind === "error") continue;
    for (const message of page.value.messages) {
      const item = await rowFor(context.store, message, subjects, input.agentIds);
      if (item !== null && matchesRuns(item, input.runIds)) items.push(item);
    }
  }

  return b3ok({ items: pageOf(items, input) });
}

/**
 * `runIds` is declared on the input and was not read, so a caller asking "what
 * did THIS shift say" got every shift the Agent ever had — with nothing to say
 * the question had been dropped.
 */
function matchesRuns(
  item: AgentCommunicationItem, runIds: readonly AgentRunId[] | undefined,
): boolean {
  if (runIds === undefined) return true;
  return item.relatedRunIds.some((runId) => runIds.includes(runId));
}

/**
 * The conversation's order, and the caller's place in it.
 *
 * Order was `messageId`, which is 128 bits of randomness in production
 * (`createSystemClock`) — so a two-Agent exchange read back in an order neither
 * Agent spoke it in. It is `occurredAt` now, with `messageId` only as the
 * tiebreak so two Messages in the same millisecond still have ONE total order
 * across pages. The cursor depends on exactly that: it names the last row the
 * caller already has, and it too was accepted and ignored, so paging past the
 * first page silently restarted it.
 */
function pageOf(
  items: AgentCommunicationItem[], input: ListAgentCommunicationsInput,
): AgentCommunicationItem[] {
  items.sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
    || left.messageId.localeCompare(right.messageId));
  const from = input.cursor === undefined
    ? 0
    : items.findIndex((item) => item.messageId === String(input.cursor)) + 1;
  return items.slice(from, from + Math.max(1, input.limit));
}

/**
 * One communication row, or null when the Message does not involve any of the
 * Agents asked about. Everything a reader needs is on the row: who sent it,
 * which way it went, what it said, and — when it was mirrored — where from.
 */
async function rowFor(
  store: MessagingStore, message: Message, subjects: ReadonlySet<PersonId>,
  agentIds: readonly AgentId[],
): Promise<AgentCommunicationItem | null> {
  const deliveries = await store.getDeliveries(message.id);
  const recipients = deliveries.kind === "ok"
    ? deliveries.value.map((delivery) => delivery.recipientId)
    : [];
  const involved = subjects.has(message.senderId)
    || recipients.some((recipient) => subjects.has(recipient));
  if (!involved) return null;

  const origin = message.body.fields?.[ORIGIN_BINDING_FIELD];
  const senderAgentId = agentIdOf(message.senderId);
  const inboxState = await inboxStateOf(store, message.id, agentIds);
  return {
    messageId: message.id,
    threadId: message.threadId,
    senderPrincipalId: message.senderId,
    recipientAgentIds: recipients
      .map(agentIdOf)
      .filter((agentId): agentId is AgentId => agentId !== null),
    relatedRunIds: await relatedRunsOf(store, message.id, agentIds),
    // The inbox item first: it is the only one of the two that moves for an
    // Agent. The `Delivery` entity stays behind it for a human recipient,
    // where no inbox item exists and it IS the delivery record.
    deliveryState: inboxState
      ?? (deliveries.kind === "ok"
        ? (deliveries.value[0]?.state ?? "unknown")
        : "unknown"),
    ...(inboxState === undefined ? {} : { inboxState }),
    occurredAt: message.createdAt,
    direction: directionOf(message, subjects),
    ...(senderAgentId === null ? {} : { senderAgentId }),
    textPreview: previewOf(message.body.text),
    ...(typeof origin === "string" ? { originBindingId: origin as never } : {}),
  };
}

/**
 * How far this Message got for the Agents being asked about, or undefined when
 * none of them was ever given an inbox item for it (a Message between people,
 * or one mirrored OUT of a terminal — neither is delivered to an Agent).
 *
 * More than one of the named Agents can hold an item for the same Message. The
 * furthest-along one is the honest single answer to "did it arrive": a row that
 * reported `queued` because one of three recipients has not been typed into yet
 * would hide a delivery that demonstrably happened.
 */
async function inboxStateOf(
  store: MessagingStore, messageId: string, agentIds: readonly AgentId[],
): Promise<AgentInboxItemState | undefined> {
  const states: AgentInboxItemState[] = [];
  for (const agentId of agentIds) {
    states.push(...await statesFor(store, agentId, messageId));
  }
  return states.reduce<AgentInboxItemState | undefined>(
    (furthest, state) =>
      furthest === undefined || rankOf(state) > rankOf(furthest) ? state : furthest,
    undefined,
  );
}

/** One Agent's inbox states for one Message — usually none, rarely one. */
async function statesFor(
  store: MessagingStore, agentId: AgentId, messageId: string,
): Promise<readonly AgentInboxItemState[]> {
  const inbox = await store.listAgentInbox(agentId);
  if (inbox.kind !== "ok") return [];
  return inbox.value
    .filter((item) => item.messageId === messageId)
    .map((item) => item.state);
}

/**
 * §8.1's six states in the order an item passes through them. `failed` sits at
 * the end deliberately: it is a terminal outcome a reader must see rather than
 * one a still-queued sibling item is allowed to mask.
 */
const INBOX_PROGRESS: readonly AgentInboxItemState[] = [
  "queued", "claimed", "submitted-unconfirmed", "submitted-confirmed",
  "transcript-observed", "failed",
];

const rankOf = (state: AgentInboxItemState): number => INBOX_PROGRESS.indexOf(state);

/**
 * The Runs a Message touched, read back from the inbox rather than remembered.
 * An item that followed an endpoint transfer names the NEW Run; the closed
 * claim still names the old one, so both stay visible.
 */
async function relatedRunsOf(
  store: MessagingStore, messageId: string, agentIds: readonly AgentId[],
): Promise<readonly AgentRunId[]> {
  const runs = new Set<AgentRunId>();
  for (const agentId of agentIds) {
    const inbox = await store.listAgentInbox(agentId);
    if (inbox.kind !== "ok") continue;
    const forMessage = inbox.value.filter((item) => item.messageId === messageId);
    for (const item of forMessage) {
      for (const runId of await runsOfItem(store, agentId, item)) runs.add(runId);
    }
  }
  return [...runs];
}

async function runsOfItem(
  store: MessagingStore, agentId: AgentId, item: AgentInboxItem,
): Promise<readonly AgentRunId[]> {
  const runs: AgentRunId[] = [];
  if (item.requestedRunId !== undefined) runs.push(item.requestedRunId);
  const claimId = item.endpointClaimId ?? await queuedAgainst(store, item, agentId);
  if (claimId === undefined) return runs;
  const claim = await store.getAgentEndpointClaim(claimId);
  if (claim.kind === "ok" && claim.value !== null) runs.push(claim.value.agentRunId);
  return runs;
}

/**
 * The claim a still-queued item is waiting on.
 *
 * `endpointClaimId` is stamped when the Runtime CLAIMS an item for delivery, so
 * an item that has only been ACCEPTED carries none — and until B3c wired the
 * `runIds` filter that cost nothing, because nobody read the field. It costs a
 * lot now: §19.2's "what has this shift been sent" answered "nothing" for every
 * Message still waiting to be typed, which is precisely the set a reader is
 * asking about. A queued item is queued for whoever holds the endpoint, so the
 * row says so. Claimed and transferred items keep their own claim and never
 * reach this, so a transfer still reads as two Runs rather than one.
 *
 * WHATEVER STATE that claim is in. Requiring `active` meant a Run that stopped
 * — which drains its endpoint (§13.6 row 1) without any Message moving — took
 * every still-queued Message out of its own shift's answer, and exam row E2
 * read `acceptances: 0` for mail the store was holding in front of it. A
 * draining claim still names the Run it belonged to, and that Run is still the
 * honest answer to "what was this shift sent". `getAgentEndpoint` always
 * returns the newest generation, so a completed transfer already reads as the
 * NEW Run here rather than the closed one.
 */
async function queuedAgainst(
  store: MessagingStore, item: AgentInboxItem, agentId: AgentId,
): Promise<AgentEndpointClaimId | undefined> {
  if (item.state !== "queued") return undefined;
  const endpoint = await store.getAgentEndpoint(agentId);
  if (endpoint.kind !== "ok" || endpoint.value === null) return undefined;
  return endpoint.value.id;
}

/**
 * Which conversations to look in.
 *
 * Membership is not the whole answer, and believing it was is what exam row J4
 * caught. §12.5 takes `threadId` and `target` as two separate arguments, so a
 * Message may be addressed to Agent B and committed into Agent A's Thread —
 * legitimately, and the CLI's `--thread` does it. `listThreadsForPerson` never
 * offers A's Thread when asked about B, so involvement — which IS decided by
 * delivery — never got to run, and "what has this Agent been sent" answered
 * "nothing" while the Agent's own durable inbox held the Message.
 *
 * The inbox is the second source, and it is the RIGHT one: §8.1 makes an inbox
 * item the durable record that this Message was accepted FOR this Agent. The
 * involvement rule below is unchanged, so widening where we look cannot widen
 * what is returned.
 */
async function threadIdsFor(
  store: MessagingStore, subjects: ReadonlySet<PersonId>,
  agentIds: readonly AgentId[], only?: ThreadId,
): Promise<readonly ThreadId[]> {
  if (only !== undefined) return [only];
  const seen = new Set<ThreadId>();
  for (const person of subjects) {
    const listed = await store.listThreadsForPerson(person);
    if (listed.kind !== "ok") continue;
    for (const thread of listed.value) seen.add(thread.id);
  }
  for (const agentId of agentIds) {
    for (const threadId of await threadsInInboxOf(store, agentId)) seen.add(threadId);
  }
  return [...seen];
}

/** Where the Messages this Agent was ACCEPTED for actually live. */
async function threadsInInboxOf(
  store: MessagingStore, agentId: AgentId,
): Promise<readonly ThreadId[]> {
  const inbox = await store.listAgentInbox(agentId);
  if (inbox.kind !== "ok") return [];
  const threads: ThreadId[] = [];
  for (const item of inbox.value) {
    const message = await store.getMessage(item.messageId);
    if (message.kind === "ok") threads.push(message.value.threadId);
  }
  return threads;
}
