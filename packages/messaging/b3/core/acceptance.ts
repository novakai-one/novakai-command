/**
 * Building one Agent-addressed acceptance — §8.1, DEC-B3V4-32.
 *
 * The order here is the whole design: commit FIRST, choose an endpoint AFTER.
 * A Message addressed to an Agent is accepted into a durable inbox before
 * anyone asks which Run currently owns that Agent's terminal, which is what
 * makes a Message that arrives mid-continuation neither rejected nor delivered
 * twice.
 *
 * This builds the acceptance directly against the store seam rather than the
 * v1 send pipeline. That is deliberate: the v1 pipeline is Chris's
 * human-to-human lane, with presence, DND, contact policy and templates. An
 * Agent has none of those — it has an endpoint and an inbox — and routing
 * Agent traffic through attention mechanics designed for a human would give an
 * Agent a Do-Not-Disturb setting, which is not a feature anyone asked for.
 */

import {
  canonicalRequestHash, nowIsoUtc,
} from "@novakai/foundation/contract";
import { schemaVersion } from "../../public/contract/index.js";
import type {
  ClientMessageId, Delivery, Message, PersonId, RecipientSnapshot, RequestHash, Sequence,
  ThreadId,
} from "../../public/contract/index.js";
import type { ClockIds } from "../../seams/clock.js";
import type { AcceptanceInput } from "../../seams/store.js";
import type {
  AgentId, AgentInboxItem, AgentInboxItemId, AgentRunId, MessagingStoreOpId,
} from "../contract/records.js";

export interface AcceptanceDraft {
  readonly senderId: PersonId;
  readonly recipients: readonly PersonId[];
  readonly threadId: ThreadId;
  readonly text: string;
  readonly clientMessageId: string;
  /** Absent for a Message nobody has to deliver into a terminal (a mirror). */
  readonly inboxFor?: {
    readonly agentId: AgentId;
    readonly requestedRunId?: string;
    readonly inboxItemId: string;
  };
}

/**
 * The full acceptance input, ready for `store.commitAcceptance`.
 *
 * The thread ref is always "by id": B3c callers hold a `threadId` because
 * §12.5 requires one, and re-deriving a direct pair here would give the store
 * two different ways to name the same Thread.
 */
export function buildAcceptance(clock: ClockIds, draft: AcceptanceDraft): AcceptanceInput {
  const messageId = clock.newId("message");
  const message: Message = {
    id: messageId,
    kind: "message",
    schemaVersion,
    createdAt: clock.now(),
    threadId: draft.threadId,
    senderId: draft.senderId,
    clientMessageId: draft.clientMessageId as ClientMessageId,
    // Assigned by the store inside the transaction (§2.3). Zero is a
    // placeholder the store always overwrites; it is never observable.
    sequence: 0 as Sequence,
    priority: "normal",
    body: { text: draft.text },
  };
  const snapshot: RecipientSnapshot = {
    id: clock.newId("snapshot"),
    kind: "recipient-snapshot",
    schemaVersion,
    createdAt: clock.now(),
    messageId,
    recipients: [...draft.recipients],
  };
  const deliveries: Delivery[] = draft.recipients.map((recipientId) => ({
    id: clock.newId("delivery"),
    kind: "delivery",
    schemaVersion,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    messageId,
    threadId: draft.threadId,
    recipientId,
    state: "pending",
  }));

  const agentInboxItems: AgentInboxItem[] = draft.inboxFor === undefined ? [] : [{
    id: draft.inboxFor.inboxItemId as AgentInboxItemId,
    kind: "agentInboxItem",
    schemaVersion: 1,
    entityRevision: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: "private",
    createdBy: draft.senderId,
    // Stamped by the persistence adapter when the operation lands; a caller
    // cannot know the record id of the operation that has not happened yet.
    lastStoreOpId: "messagingStoreOp_pending" as MessagingStoreOpId,
    agentId: draft.inboxFor.agentId,
    messageId,
    ...(draft.inboxFor.requestedRunId === undefined
      ? {}
      : { requestedRunId: draft.inboxFor.requestedRunId as AgentRunId }),
    // Overwritten by the store with the sequence it assigns (§8.1).
    acceptedSequence: 0,
    state: "queued",
  }];

  return {
    idempotency: {
      senderId: draft.senderId,
      clientMessageId: draft.clientMessageId as ClientMessageId,
      // The hash is over what the send MEANS. Two sends with the same key but
      // different text are a caller bug and must surface as IdempotencyConflict
      // rather than silently returning the first one's outcome (§2.2, A5).
      requestHash: canonicalRequestHash({
        threadId: draft.threadId,
        senderId: draft.senderId,
        recipients: [...draft.recipients].sort(),
        text: draft.text,
      }) as RequestHash,
    },
    thread: { kind: "room", threadId: draft.threadId },
    message,
    snapshot,
    deliveries,
    ...(agentInboxItems.length > 0 ? { agentInboxItems } : {}),
  };
}
