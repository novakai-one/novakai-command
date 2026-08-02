/**
 * The B3c Messaging capability, composed — §12.5 plus the surfaces the
 * pre-build hold-out exam proved were needed to use it from outside.
 *
 * Messaging remains the sole writer of every fact here (§3.3, red gate 18).
 * Agent Runtime asks it to reserve and transfer endpoints; Transcript asks it
 * to mirror a turn; Shell asks it what exists. None of them writes.
 */

import {
  b3err, b3fail, b3ok, mintAgentInboxItemId, nowIsoUtc,
  type AuthenticatedPrincipal, type B3Result, type CommandContext, type Page,
  type SystemCommandContext,
} from "@novakai/foundation/contract";
import type { PersonId, Thread, ThreadId } from "../../public/contract/index.js";
import type { ClockIds } from "../../seams/clock.js";
import type { MessagingStore } from "../../seams/store.js";
import type {
  AgentEndpointView, AgentMessagingContract, CommitTerminalOriginatedMessageInput,
  ConversationView, EnsureDirectThreadInput, EnsureGroupThreadInput,
  ListAgentCommunicationsInput, ListAgentInboxInput, MessageAcceptance,
  OpenConversationViewInput, RecordInboxSubmissionInput, ReserveAgentEndpointInput,
  SendAgentMessageInput, TransferAgentEndpointInput,
} from "../contract/api.js";
import type {
  AgentCommunicationItem, AgentEndpointClaim, AgentEndpointClaimId, AgentId,
  AgentInboxItem, AgentInboxItemId,
} from "../contract/records.js";
import {
  activateAgentEndpointClaim, findClaim, reserveAgentEndpointClaim,
  transferAgentEndpointClaim,
} from "./endpoints.js";
import {
  commitTerminalOriginatedMessage, sendAgentMessage,
} from "./send.js";
import { ensureDirectThread, ensureGroupThread, storeError } from "./threads.js";
import { listAgentCommunications } from "./views.js";

export interface AgentMessagingOptions {
  readonly store: MessagingStore;
  readonly clock: ClockIds;
  /**
   * Where an opened conversation is recorded. Shell owns the `conversationView`
   * kind (§18.1), so Messaging asks rather than writes. Absent means "nothing
   * is pinned anywhere", which is the honest default for a headless host and
   * keeps red gate 12 trivially true.
   */
  readonly conversationViews?: ConversationViewPort;
  /**
   * Where §15's committed facts go. Messaging owns the facts; the composition
   * root owns the stream, so a consumer holds ONE cursor across every
   * capability (§24.4) instead of trying to order two.
   */
  readonly emit?: CapabilityEventEmitter;
}

export type CapabilityEventEmitter = (
  kind: string, payload: Readonly<Record<string, unknown>>,
) => void;

/** The Shell-owned sidebar, seen through the narrowest possible door. */
export interface ConversationViewPort {
  open(view: ConversationView): Promise<void>;
  close(threadId: ThreadId): Promise<void>;
  list(): Promise<readonly ConversationView[]>;
}

const endpointEvent = "messaging.agent-endpoint.changed";

const claimPayload = (claim: AgentEndpointClaim): Record<string, unknown> => ({
  claimId: claim.id,
  agentId: claim.agentId,
  agentRunId: claim.agentRunId,
  endpointGeneration: claim.endpointGeneration,
  state: claim.state,
  ...(claim.cutoffMessageSequence === undefined
    ? {} : { cutoffMessageSequence: claim.cutoffMessageSequence }),
});

/** The default: an in-memory port for hosts with no sidebar (CLI, harnesses). */
export function createMemoryConversationViews(): ConversationViewPort {
  const views = new Map<ThreadId, ConversationView>();
  return {
    async open(view) { views.set(view.threadId, view); },
    async close(threadId) {
      const existing = views.get(threadId);
      if (existing) views.set(threadId, { ...existing, open: false });
    },
    async list() { return [...views.values()]; },
  };
}

export function composeAgentMessaging(options: AgentMessagingOptions): AgentMessagingContract {
  const { store, clock } = options;
  const views = options.conversationViews ?? createMemoryConversationViews();
  const emit = options.emit ?? (() => undefined);

  /** Emit only after the operation is durable — never on the way in. */
  function announce<T>(
    result: B3Result<T>, kind: string, payload: (value: T) => Record<string, unknown>,
  ): B3Result<T> {
    if (result.ok) emit(kind, payload(result.value));
    return result;
  }

  async function writeItem(item: AgentInboxItem): Promise<B3Result<AgentInboxItem>> {
    const written = await store.transitionAgentInboxItem(item);
    if (written.kind === "error") return b3fail(storeError(written.error));
    return announce(b3ok(written.value), "messaging.agent-inbox.changed", (saved) => ({
      inboxItemId: saved.id,
      agentId: saved.agentId,
      messageId: saved.messageId,
      state: saved.state,
      ...(saved.endpointClaimId === undefined
        ? {} : { endpointClaimId: saved.endpointClaimId }),
    }));
  }

  return {
    // --- §12.5 send ---------------------------------------------------------
    async sendAgentMessage(context: CommandContext, input: SendAgentMessageInput) {
      const sent = await sendAgentMessage({ store, clock }, context, input);
      // The inbox item is committed INSIDE the acceptance transaction, not
      // through a later transition — so without this the durable inbox would
      // change with no `agent-inbox.changed` event to say so, and a consumer
      // watching the stream would see a Message arrive for an Agent whose
      // inbox never appeared to move.
      if (sent.ok && sent.value.inboxItemId !== undefined && !sent.value.duplicate) {
        emit("messaging.agent-inbox.changed", {
          inboxItemId: sent.value.inboxItemId,
          messageId: sent.value.messageId,
          state: "queued",
        });
      }
      return announce(sent, "messaging.agent-message.committed", (acceptance) => ({
        messageId: acceptance.messageId,
        threadId: acceptance.threadId,
        state: acceptance.state,
        duplicate: acceptance.duplicate,
        ...(acceptance.inboxItemId === undefined
          ? {} : { inboxItemId: acceptance.inboxItemId }),
      }));
    },

    async commitTerminalOriginatedMessage(
      _context: SystemCommandContext<"sys_transcript">,
      input: CommitTerminalOriginatedMessageInput,
    ) {
      const committed = await commitTerminalOriginatedMessage({ store, clock }, input);
      return announce(committed, "messaging.agent-message.committed", (acceptance) => ({
        messageId: acceptance.messageId,
        threadId: acceptance.threadId,
        state: acceptance.state,
        duplicate: acceptance.duplicate,
        originBindingId: input.bindingId,
      }));
    },

    // --- §12.5 endpoint lifecycle ------------------------------------------
    async reserveAgentEndpointClaim(
      _context: SystemCommandContext<"sys_agent_runtime">, input: ReserveAgentEndpointInput,
    ) {
      return announce(await reserveAgentEndpointClaim(store, input), endpointEvent, claimPayload);
    },

    async activateAgentEndpointClaim(
      _context: SystemCommandContext<"sys_agent_runtime">, claimId: AgentEndpointClaimId,
    ) {
      return announce(await activateAgentEndpointClaim(store, claimId), endpointEvent, claimPayload);
    },

    async transferAgentEndpointClaim(
      _context: SystemCommandContext<"sys_agent_runtime">, input: TransferAgentEndpointInput,
    ) {
      const moved = await transferAgentEndpointClaim(store, input);
      // Every item that followed the endpoint changed, and each one is a fact
      // a consumer tracking "where is my Message" needs (§13.6).
      if (moved.ok) {
        const inbox = await store.listAgentInbox(input.agentId);
        if (inbox.kind === "ok") {
          for (const item of inbox.value) {
            if (item.endpointClaimId !== moved.value.id) continue;
            emit("messaging.agent-inbox.changed", {
              inboxItemId: item.id,
              messageId: item.messageId,
              state: item.state,
              endpointClaimId: item.endpointClaimId,
            });
          }
        }
      }
      return announce(moved, endpointEvent, claimPayload);
    },

    // --- §12.5 send ---------------------------------------------------------
    // --- §12.5 threads and conversation views -------------------------------
    ensureDirectThread: (
      _context: CommandContext, input: EnsureDirectThreadInput,
    ): Promise<B3Result<Thread>> => ensureDirectThread(store, input),

    ensureGroupThread: (
      _context: CommandContext, input: EnsureGroupThreadInput,
    ): Promise<B3Result<Thread>> => ensureGroupThread(store, input),

    async openConversationView(context: CommandContext, input: OpenConversationViewInput) {
      const thread = await store.getThread(input.threadId);
      if (thread.kind === "error") return b3fail(storeError(thread.error));
      const view: ConversationView = {
        threadId: input.threadId,
        openedForPrincipalId: String(context.principal.id),
        membershipKind: input.membership.kind,
        open: true,
        openedAt: nowIsoUtc(),
      };
      await views.open(view);
      return b3ok(view);
    },

    async closeConversationView(context: CommandContext, threadId: ThreadId) {
      await views.close(threadId);
      const listed = await views.list();
      const found = listed.find((view) => view.threadId === threadId);
      return b3ok(found ?? {
        threadId,
        openedForPrincipalId: String(context.principal.id),
        membershipKind: "direct" as const,
        open: false,
        openedAt: nowIsoUtc(),
      });
    },

    // --- inbox delivery transitions -----------------------------------------
    async claimNextInboxItem(
      _context: SystemCommandContext<"sys_agent_runtime">, agentId: AgentId,
    ) {
      const endpoint = await store.getAgentEndpoint(agentId);
      if (endpoint.kind === "error") return b3fail(storeError(endpoint.error));
      if (endpoint.value === null || endpoint.value.state !== "active") return b3ok(null);
      const inbox = await store.listAgentInbox(agentId);
      if (inbox.kind === "error") return b3fail(storeError(inbox.error));
      // Only `queued`. A `claimed` item is already out for delivery and a
      // `submitted-unconfirmed` one must never be handed out again — its
      // keystrokes already reached the PTY (§20).
      const next = inbox.value.find((item) => item.state === "queued");
      if (next === undefined) return b3ok(null);
      return writeItem({ ...next, state: "claimed", endpointClaimId: endpoint.value.id });
    },

    async recordInboxSubmission(
      _context: SystemCommandContext<"sys_agent_runtime">, input: RecordInboxSubmissionInput,
    ) {
      const found = await store.getAgentInboxItem(input.inboxItemId as AgentInboxItemId);
      if (found.kind === "error") return b3fail(storeError(found.error));
      if (found.value === null) {
        return b3fail(b3err("ValidationFailed", `no inbox item ${input.inboxItemId}`,
          { issues: [{ path: "inboxItemId", message: "unknown" }] }, false));
      }
      return writeItem({
        ...found.value,
        state: input.outcome,
        ...(input.terminalInputAttemptId === undefined
          ? {} : { terminalInputAttemptId: input.terminalInputAttemptId }),
        ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      });
    },

    // --- §19.2 queries -------------------------------------------------------
    listAgentCommunications: (
      _principal: AuthenticatedPrincipal, input: ListAgentCommunicationsInput,
    ): Promise<B3Result<Page<AgentCommunicationItem>>> =>
      listAgentCommunications({ store }, input),

    async listAgentInbox(_principal: AuthenticatedPrincipal, input: ListAgentInboxInput) {
      const inbox = await store.listAgentInbox(input.agentId);
      if (inbox.kind === "error") return b3fail(storeError(inbox.error));
      const wanted = input.states;
      const items = wanted === undefined
        ? inbox.value
        : inbox.value.filter((item) => wanted.includes(item.state));
      return b3ok({ items: items.slice(0, input.limit ?? items.length) });
    },

    async getAgentEndpoint(
      _principal: AuthenticatedPrincipal, agentId: AgentId,
    ): Promise<B3Result<AgentEndpointView>> {
      const claims = await store.listAgentEndpointClaims(agentId);
      if (claims.kind === "error") return b3fail(storeError(claims.error));
      const current = await store.getAgentEndpoint(agentId);
      if (current.kind === "error") return b3fail(storeError(current.error));
      const generation = claims.value.reduce(
        (highest, claim) => Math.max(highest, claim.endpointGeneration), -1,
      );
      const cutoff = current.value?.cutoffMessageSequence;
      return b3ok({
        agentId,
        claim: current.value,
        endpointGeneration: generation,
        ...(cutoff === undefined ? {} : { cutoffMessageSequence: cutoff }),
      });
    },

    async listConversationViews(_principal: AuthenticatedPrincipal) {
      return b3ok({ items: [...await views.list()] });
    },
  };
}

export type { AgentEndpointClaim, AgentInboxItem };
export { findClaim };
