/**
 * The B3c Messaging capability contract — B3V4-P2 §12.5, §12.7, §19.2.
 *
 * §12.5 publishes six operations. The pre-build hold-out exam found that six
 * is not enough to USE from outside: `SendAgentMessageInput.threadId` and
 * `OpenConversationViewInput.threadId` are both required and nothing in the
 * spec mints a Thread. So this contract also publishes the thread
 * resolve/mint surface, the inbox/endpoint reads a caller needs to know what
 * happened to a Message, and the conversation-view list that makes "no
 * sidebar flood" (red gate 12) checkable from outside rather than asserted.
 *
 * Everything here is additive to §12.5 and uses its exact names for its exact
 * operations. B3b shipped drifted names once; a second host written from the
 * spec calls the spec's name.
 */

import type {
  B3Result, CommandContext, EventCursor, Page, SystemCommandContext,
  AuthenticatedPrincipal,
} from "@novakai/foundation/contract";
import type { Thread, ThreadId } from "../../public/contract/index.js";
import type {
  AgentCommunicationItem, AgentEndpointClaim, AgentEndpointClaimId, AgentId,
  AgentInboxItem, AgentRunId, TerminalInputAttemptId, TerminalSessionId,
  TranscriptBindingId,
} from "./records.js";

// --- §12.5 inputs -------------------------------------------------------------

export interface ReserveAgentEndpointInput {
  readonly agentId: AgentId;
  readonly agentRunId: AgentRunId;
  readonly terminalSessionId: TerminalSessionId;
  readonly expectedEndpointGeneration: number;
}

export interface TransferAgentEndpointInput {
  readonly agentId: AgentId;
  readonly expectedOldClaimId: AgentEndpointClaimId;
  readonly newRunId: AgentRunId;
  readonly newTerminalSessionId: TerminalSessionId;
  readonly oldFinalTranscriptWatermark: string;
  readonly expectedEndpointGeneration: number;
}

export type AgentMessageTarget =
  | { readonly kind: "agent"; readonly agentId: AgentId }
  | { readonly kind: "exact-run"; readonly agentRunId: AgentRunId };

export interface SendAgentMessageInput {
  readonly target: AgentMessageTarget;
  /**
   * §12.5 declares this required. It stays required — but `ensureDirectThread`
   * and `ensureGroupThread` below are how a caller obtains one, and
   * `MessageAcceptance` returns the resolved Thread so a caller that already
   * had it never has to look it up again.
   */
  readonly threadId: ThreadId;
  readonly text: string;
  /**
   * Deterministic idempotency key. Absent means "mint one" — honest for an
   * interactive send, wrong for anything that retries, which is why the CLI
   * and the wire both pass one.
   */
  readonly clientMessageId?: string;
}

export interface MessageAcceptance {
  readonly messageId: string;
  readonly inboxItemId?: string;
  readonly acceptedAt: string;
  readonly state:
    | "committed"
    | "queued-for-agent"
    | "submitted-confirmed"
    | "submitted-unconfirmed";
  /** The Thread the Message landed in — surface #2's "returns the resolved Thread". */
  readonly threadId: ThreadId;
  /** True when this send was an idempotent replay of one already accepted. */
  readonly duplicate: boolean;
}

/** §12.7 — the transcript turn a terminal-originated Message is mirrored from. */
export interface NormalisedTranscriptTurn {
  readonly transcriptLineId: string;
  readonly bindingId: TranscriptBindingId;
  readonly sourcePosition: string;
  readonly role: "human" | "assistant";
  readonly text: string;
  readonly occurredAt?: string;
  readonly sourceDigest: string;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
}

export interface CommitTerminalOriginatedMessageInput {
  readonly bindingId: TranscriptBindingId;
  readonly turn: NormalisedTranscriptTurn;
  readonly threadId: ThreadId;
  /**
   * The endpoint the turn came FROM. Stored with the Message so delivery can
   * never route it back into the same endpoint (§8.2's loopback rule).
   */
  readonly sourceEndpointClaimId: AgentEndpointClaimId;
  /** The Agent whose terminal this is. */
  readonly agentId: AgentId;
}

export type ConversationMembership =
  | { readonly kind: "direct"; readonly agentId: AgentId }
  | { readonly kind: "group"; readonly agentIds: readonly AgentId[] };

export interface OpenConversationViewInput {
  readonly threadId: ThreadId;
  readonly membership: ConversationMembership;
}

export interface ConversationView {
  readonly threadId: ThreadId;
  readonly openedForPrincipalId: string;
  readonly membershipKind: "direct" | "group";
  /** False once explicitly closed — history is never deleted (§19.2). */
  readonly open: boolean;
  readonly openedAt: string;
}

export interface ListAgentCommunicationsInput {
  readonly agentIds: readonly AgentId[];
  readonly runIds?: readonly AgentRunId[];
  readonly threadId?: ThreadId;
  readonly cursor?: EventCursor;
  readonly limit: number;
}

// --- B3c-added surfaces (the hold-out's ten) ----------------------------------

export interface EnsureDirectThreadInput {
  /** The two participants. A human is named by principal; an Agent by AgentId. */
  readonly between: readonly [ConversationParticipant, ConversationParticipant];
}

export interface EnsureGroupThreadInput {
  readonly participants: readonly ConversationParticipant[];
}

export type ConversationParticipant =
  | { readonly kind: "agent"; readonly agentId: AgentId }
  | { readonly kind: "human"; readonly personId: string };

export interface ListAgentInboxInput {
  readonly agentId: AgentId;
  readonly states?: readonly AgentInboxItem["state"][];
  readonly limit?: number;
}

/** §12.7's endpoint read, plus the two facts a caller cannot otherwise learn. */
export interface AgentEndpointView {
  readonly agentId: AgentId;
  readonly claim: AgentEndpointClaim | null;
  readonly endpointGeneration: number;
  readonly cutoffMessageSequence?: number;
}

export interface RecordInboxSubmissionInput {
  readonly inboxItemId: string;
  readonly outcome: "submitted-confirmed" | "submitted-unconfirmed" | "failed";
  readonly terminalInputAttemptId?: TerminalInputAttemptId;
  readonly failureReason?: string;
}

// --- the capability -----------------------------------------------------------

export interface AgentMessagingCommands {
  reserveAgentEndpointClaim(
    ctx: SystemCommandContext<"sys_agent_runtime">, input: ReserveAgentEndpointInput,
  ): Promise<B3Result<AgentEndpointClaim>>;

  activateAgentEndpointClaim(
    ctx: SystemCommandContext<"sys_agent_runtime">, claimId: AgentEndpointClaimId,
  ): Promise<B3Result<AgentEndpointClaim>>;

  /**
   * §13.6 row 2 — "old endpoint draining", its own step.
   *
   * The continuation ladder fences the old endpoint before the replacement is
   * provisioned, and that gap is real: a failed continuation never reaches the
   * transfer, so a claim that could only be drained as part of a successful
   * transfer would leave nothing fenced at all.
   */
  drainAgentEndpointClaim(
    ctx: SystemCommandContext<"sys_agent_runtime">, claimId: AgentEndpointClaimId,
  ): Promise<B3Result<AgentEndpointClaim>>;

  transferAgentEndpointClaim(
    ctx: SystemCommandContext<"sys_agent_runtime">, input: TransferAgentEndpointInput,
  ): Promise<B3Result<AgentEndpointClaim>>;

  sendAgentMessage(
    ctx: CommandContext, input: SendAgentMessageInput,
  ): Promise<B3Result<MessageAcceptance>>;

  commitTerminalOriginatedMessage(
    ctx: SystemCommandContext<"sys_transcript">, input: CommitTerminalOriginatedMessageInput,
  ): Promise<B3Result<MessageAcceptance>>;

  openConversationView(
    ctx: CommandContext, input: OpenConversationViewInput,
  ): Promise<B3Result<ConversationView>>;

  /** §19.2: opening is deliberate, so un-opening has to be too. */
  closeConversationView(
    ctx: CommandContext, threadId: ThreadId,
  ): Promise<B3Result<ConversationView>>;

  /** Surface #2 — the blocker. Get-or-create; the same pair is one Thread forever. */
  ensureDirectThread(
    ctx: CommandContext, input: EnsureDirectThreadInput,
  ): Promise<B3Result<Thread>>;

  ensureGroupThread(
    ctx: CommandContext, input: EnsureGroupThreadInput,
  ): Promise<B3Result<Thread>>;

  /** Terminal reports what happened to a claimed item. Never inferred. */
  recordInboxSubmission(
    ctx: SystemCommandContext<"sys_agent_runtime">, input: RecordInboxSubmissionInput,
  ): Promise<B3Result<AgentInboxItem>>;

  /** Move a queued item to `claimed` for the Agent's live endpoint. */
  claimNextInboxItem(
    ctx: SystemCommandContext<"sys_agent_runtime">, agentId: AgentId,
  ): Promise<B3Result<AgentInboxItem | null>>;
}

export interface AgentMessagingQueries {
  listAgentCommunications(
    principal: AuthenticatedPrincipal, input: ListAgentCommunicationsInput,
  ): Promise<B3Result<Page<AgentCommunicationItem>>>;

  listAgentInbox(
    principal: AuthenticatedPrincipal, input: ListAgentInboxInput,
  ): Promise<B3Result<Page<AgentInboxItem>>>;

  getAgentEndpoint(
    principal: AuthenticatedPrincipal, agentId: AgentId,
  ): Promise<B3Result<AgentEndpointView>>;

  /** Red gate 12 in readable form: what IS pinned in Chris's sidebar. */
  listConversationViews(
    principal: AuthenticatedPrincipal,
  ): Promise<B3Result<Page<ConversationView>>>;
}

export type AgentMessagingContract = AgentMessagingCommands & AgentMessagingQueries;
