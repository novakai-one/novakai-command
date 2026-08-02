/**
 * B3c Messaging records — B3V4-P2 §8.1.
 *
 * Two facts, and both of them exist because a Run can be replaced underneath a
 * Message that has already been accepted:
 *
 *   AgentEndpointClaim  — which Run currently owns an Agent's terminal endpoint,
 *                         and which generation that is. A continuation closes
 *                         one and opens the next; the generation is what makes
 *                         "old" and "new" different records rather than one
 *                         record overwritten (§13.6).
 *   AgentInboxItem      — one durable acceptance per (Agent, Message), committed
 *                         BEFORE any endpoint is chosen. DEC-B3V4-32: Messaging
 *                         accepts to the inbox first, so a Message that arrives
 *                         mid-replacement is neither rejected nor delivered
 *                         twice.
 *
 * §18.1 is explicit that neither of these gets a file: they are entities inside
 * the Messaging StoreOp payload, and `messagingStoreOps.jsonl` is the only
 * Messaging JSONL that exists.
 *
 * These types are deliberately free of any `@novakai/foundation` import. The
 * Messaging CORE stays host-agnostic and standalone-runnable (requirement 1);
 * only the durability ADAPTER knows Foundation exists.
 */

import type { MessageId, ThreadId } from "../../public/contract/index.js";

/** `agent_<uuidv4>` — the stable individual (DEC-B3V4-02). */
export type AgentId = string & { readonly __brand: "AgentId" };
/** `agentRun_<uuidv7>` — one provider context. NOT interchangeable with AgentId. */
export type AgentRunId = string & { readonly __brand: "AgentRunId" };
/** `terminal_<uuidv7>` — Terminal's session identity. */
export type TerminalSessionId = string & { readonly __brand: "TerminalSessionId" };
/** `terminalInput_<uuidv7>` — one ordered input outcome. */
export type TerminalInputAttemptId = string & { readonly __brand: "TerminalInputAttemptId" };
/** `agentEndpoint_<base32sha256>` (§4.1). */
export type AgentEndpointClaimId = string & { readonly __brand: "AgentEndpointClaimId" };
/** `agentInbox_<base32sha256>` (§4.1). */
export type AgentInboxItemId = string & { readonly __brand: "AgentInboxItemId" };
/** `messagingStoreOp_<base32sha256>` (§4.1). */
export type MessagingStoreOpId = string & { readonly __brand: "MessagingStoreOpId" };
/** `transcriptBinding_<base32sha256>` (§4.1) — Transcript's identity, referenced here. */
export type TranscriptBindingId = string & { readonly __brand: "TranscriptBindingId" };

/** Foundation's vocabulary, restated rather than imported (see the header). */
export type PermissionLevel = "private" | "shared" | "public";
export type MessagingPrincipalId = string;

export interface MessagingEntityView<Id extends string, Kind extends string> {
  readonly id: Id;
  readonly kind: Kind;
  readonly schemaVersion: 1;
  readonly entityRevision: number;
  readonly createdAt: string;
  readonly permissionLevel: PermissionLevel;
  readonly createdBy: MessagingPrincipalId;
  readonly lastStoreOpId: MessagingStoreOpId;
}

export type AgentEndpointState = "reserved" | "active" | "draining" | "closed";

export interface AgentEndpointClaim
  extends MessagingEntityView<AgentEndpointClaimId, "agentEndpointClaim"> {
  readonly agentId: AgentId;
  readonly agentRunId: AgentRunId;
  readonly terminalSessionId: TerminalSessionId;
  readonly endpointGeneration: number;
  readonly state: AgentEndpointState;
  /**
   * The Message sequence past which an exact-Run send to THIS Run fails
   * (`ExactRunEndpointClosed`). Set when the claim starts draining — before
   * that there is nothing to be after.
   */
  readonly cutoffMessageSequence?: number;
  readonly finalTranscriptWatermark?: string;
}

/**
 * §8.1's six states, in the order a delivered item passes through them.
 *
 * `submitted-unconfirmed` is the one that must never be automatically retried
 * or redirected: the keystrokes reached the PTY and Novakai does not know
 * whether the provider read them. §20 makes that a human/script decision.
 */
export type AgentInboxItemState =
  | "queued"
  | "claimed"
  | "submitted-confirmed"
  | "submitted-unconfirmed"
  | "transcript-observed"
  | "failed";

export interface AgentInboxItem
  extends MessagingEntityView<AgentInboxItemId, "agentInboxItem"> {
  readonly agentId: AgentId;
  readonly messageId: MessageId;
  /** Set only for an exact-run send; absent means "whichever Run holds the endpoint". */
  readonly requestedRunId?: AgentRunId;
  readonly acceptedSequence: number;
  readonly state: AgentInboxItemState;
  readonly endpointClaimId?: AgentEndpointClaimId;
  readonly terminalInputAttemptId?: TerminalInputAttemptId;
  readonly failureReason?: string;
}

/**
 * The direction a Message travelled relative to the Agent being inspected
 * (surface #8). Without it a communication list is a pile of texts with no
 * indication of who said what to whom.
 */
export type AgentCommunicationDirection = "to-agent" | "from-agent" | "between-agents";

export interface AgentCommunicationItem {
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly senderPrincipalId: MessagingPrincipalId;
  readonly recipientAgentIds: readonly AgentId[];
  readonly relatedRunIds: readonly AgentRunId[];
  /**
   * How far this Message actually got. For Agent-addressed mail that is §8.1's
   * inbox item — the `Delivery` entity is a stub the Agent path never
   * transitions, so this field read `pending` next to an item that said
   * `submitted-confirmed`, forever. §19.2's whole job is answering "what has
   * this Agent been sent, and did it arrive"; the free-form `string` the spec
   * gives this field is what lets it carry the honest answer.
   */
  readonly deliveryState: string;
  /** The same fact in §8.1's typed vocabulary, when an inbox item exists. */
  readonly inboxState?: AgentInboxItemState;
  readonly occurredAt: string;
  /** §19.2 inspection is useless if you cannot tell inbound from outbound. */
  readonly direction: AgentCommunicationDirection;
  readonly senderAgentId?: AgentId;
  /** Bounded preview so a list read does not require N message fetches. */
  readonly textPreview: string;
  /**
   * Set when the Message was mirrored FROM a transcript rather than sent
   * through Novakai — the evidence that terminal and app are one conversation.
   */
  readonly originBindingId?: TranscriptBindingId;
}

export const PREVIEW_MAX_CHARS = 160;

/** One-line preview, never a truncation that hides that it truncated. */
export function previewOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= PREVIEW_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}
