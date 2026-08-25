// Where Agent Runtime's B3c ports meet Messaging and Transcript.
//
// The same rule as `run-ports.ts`: Agent Runtime declares the narrow thing it
// needs, the capability implements its own contract, and the composition root
// translates. The Runtime holding the whole Messaging contract could send a
// Message as anyone; holding this port it can only move the claim that says
// which Run owns an Agent's terminal.
//
// This file exists because the B3c capability code shipped without it — the
// spawn ladder recorded `endpoint-reserved`, `transcript-bound` and
// `endpoint-active` as deferred, so a live governed Agent had no endpoint and
// no transcript custody, and the whole terminal-mirror direction had no
// reachable surface.
import {
  b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
  type AgentId, type AgentRunId, type B3Result, type CommandContext,
  type HumanPrincipalId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  MessagingEndpointPort, MessagingInboxPort, TranscriptCustodyPort,
} from '../../../agent-runtime/contract/index.js';
import type {
  AgentEndpointClaimId, AgentMessagingContract,
  AgentId as MessagingAgentId, AgentRunId as MessagingAgentRunId,
  MessagingStore, TerminalSessionId as MessagingTerminalSessionId,
} from '../../../messaging/contract/index.js';

/** The exact owner reads the semantic delivery port makes. */
type MessagingReadPort = Pick<MessagingStore, 'getMessage' | 'getAgentInboxItem'>;
import type { B3TranscriptContract } from '../../../transcript/b3/contract/index.js';

const runtimeSystem = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

/**
 * The thread-minting call is an ordinary command, not a system one: §12.5 types
 * `ensureDirectThread` to `CommandContext`, and the Runtime asking on an
 * Agent's behalf is the composition root acting for the human who owns it.
 */
const humanContext = (principalId: HumanPrincipalId): CommandContext => ({
  principal: { id: principalId, kind: 'human', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

/** Messaging, narrowed to the endpoint claim and the Agent's own Thread. */
export function messagingEndpointPort(
  messaging: AgentMessagingContract,
): MessagingEndpointPort {
  return {
    async ensureAgentThread(input) {
      // Deterministic get-or-create over the same pair forever, so a Run and
      // its continuation mirror into ONE conversation rather than a new Thread
      // per shift.
      const thread = await messaging.ensureDirectThread(
        humanContext(input.rootHumanPrincipalId), {
          between: [
            { kind: 'human', personId: String(input.rootHumanPrincipalId) },
            { kind: 'agent', agentId: input.agentId as string as MessagingAgentId },
          ],
        },
      );
      if (!thread.ok) return thread;
      return b3ok({ threadId: String(thread.value.id) });
    },

    async currentEndpoint(agentId: AgentId) {
      const endpoint = await messaging.getAgentEndpoint(
        { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
        agentId as string as MessagingAgentId,
      );
      if (!endpoint.ok) return endpoint;
      return b3ok({
        claimId: endpoint.value.claim === null ? null : String(endpoint.value.claim.id),
        endpointGeneration: endpoint.value.endpointGeneration,
        ...(endpoint.value.claim === null
          ? {} : { agentRunId: String(endpoint.value.claim.agentRunId) }),
      });
    },

    async reserve(input) {
      const reserved = await messaging.reserveAgentEndpointClaim(runtimeSystem(), {
        agentId: input.agentId as string as MessagingAgentId,
        agentRunId: input.agentRunId as string as MessagingAgentRunId,
        terminalSessionId: input.terminalSessionId as string as MessagingTerminalSessionId,
        expectedEndpointGeneration: input.expectedEndpointGeneration,
      });
      if (!reserved.ok) return reserved;
      return b3ok({
        claimId: String(reserved.value.id),
        endpointGeneration: reserved.value.endpointGeneration,
      });
    },

    async activate(claimId) {
      const active = await messaging.activateAgentEndpointClaim(
        runtimeSystem(), claimId as AgentEndpointClaimId,
      );
      if (!active.ok) return active;
      return b3ok({ claimId: String(active.value.id) });
    },

    async drain(claimId) {
      const drained = await messaging.drainAgentEndpointClaim(
        runtimeSystem(), claimId as AgentEndpointClaimId,
      );
      if (!drained.ok) return drained;
      return b3ok({ claimId: String(drained.value.id) });
    },

    async transfer(input) {
      const moved = await messaging.transferAgentEndpointClaim(runtimeSystem(), {
        agentId: input.agentId as string as MessagingAgentId,
        expectedOldClaimId: input.expectedOldClaimId as AgentEndpointClaimId,
        newRunId: input.newRunId as string as MessagingAgentRunId,
        newTerminalSessionId: input.newTerminalSessionId as string as MessagingTerminalSessionId,
        oldFinalTranscriptWatermark: input.oldFinalTranscriptWatermark,
        expectedEndpointGeneration: input.expectedEndpointGeneration,
      });
      if (!moved.ok) return moved;
      return b3ok({
        claimId: String(moved.value.id),
        endpointGeneration: moved.value.endpointGeneration,
      });
    },
  };
}

/**
 * Messaging, narrowed to delivery: take the next item for this Agent, and say
 * what the terminal did with it.
 *
 * The Message text is read here rather than in the Runtime, which is the whole
 * point of the port: the Runtime types what it is handed and has no way to read
 * a Message it was not handed.
 */
export function messagingInboxPort(
  messaging: AgentMessagingContract & { readonly store: MessagingReadPort },
): MessagingInboxPort {
  async function sourceFact(item: {
    readonly id: string;
    readonly messageId: string;
  }): Promise<B3Result<{
    readonly inboxItemId: string;
    readonly messageId: string;
    readonly text: string;
  }>> {
    const message = await messaging.store.getMessage(item.messageId as never);
    if (message.kind !== 'ok') {
      return b3fail({
        code: 'StoreUnavailable',
        message: `no Message ${item.messageId} for an inbox item`,
        details: { owner: 'messaging', cause: 'message-unreadable' },
        retryable: true,
      });
    }
    return b3ok({
      inboxItemId: String(item.id),
      messageId: String(item.messageId),
      text: message.value.body.text,
    });
  }

  return {
    async getSource(inboxItemId: string) {
      const item = await messaging.store.getAgentInboxItem(inboxItemId as never);
      if (item.kind === 'error') {
        return b3fail({
          code: 'StoreUnavailable', message: 'Messaging inbox source is unavailable',
          details: { owner: 'messaging', inboxItemId }, retryable: true,
        });
      }
      return item.value === null ? b3ok(null) : sourceFact(item.value);
    },

    async peekNext(agentId: AgentId) {
      const listed = await messaging.listAgentInbox(runtimeSystem().principal, {
        agentId: agentId as string as MessagingAgentId,
        states: ['queued'],
        limit: 1,
      });
      if (!listed.ok) return listed;
      const next = listed.value.items[0];
      return next === undefined ? b3ok(null) : sourceFact(next);
    },

    async claimNext(agentId: AgentId) {
      const claimed = await messaging.claimNextInboxItem(
        runtimeSystem(), agentId as string as MessagingAgentId,
      );
      if (!claimed.ok) return claimed;
      if (claimed.value === null) return b3ok(null);
      const fact = await sourceFact(claimed.value);
      if (!fact.ok) {
        // The item is already `claimed` and there is nothing to type. Saying so
        // is what keeps it off the queue and in front of a human, rather than
        // silently re-offered on the next pass for ever.
        await messaging.recordInboxSubmission(runtimeSystem(), {
          inboxItemId: claimed.value.id,
          outcome: 'failed',
          failureReason: `the accepted Message ${claimed.value.messageId} could not be read back`,
        });
        return fact;
      }
      return fact;
    },

    async recordSubmission(input) {
      const recorded = await messaging.recordInboxSubmission(runtimeSystem(), {
        inboxItemId: input.inboxItemId as never,
        outcome: input.outcome,
        ...(input.terminalInputAttemptId === undefined
          ? {} : { terminalInputAttemptId: input.terminalInputAttemptId as never }),
        ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
      });
      if (!recorded.ok) return recorded;
      return b3ok({ state: recorded.value.state });
    },
  };
}

/** Transcript, narrowed to custody: bind this Run, and say how far it got. */
export function transcriptCustodyPort(
  transcript: () => B3TranscriptContract | null,
): TranscriptCustodyPort {
  const unavailable = (): B3Result<never> => b3fail({
    code: 'RuntimeUnavailable',
    message: 'no Transcript capability is composed in this host',
    details: { reason: 'transcript-not-composed' },
    retryable: false,
  });

  return {
    async bind(input) {
      const custody = transcript();
      if (custody === null) return unavailable();
      const bound = await custody.bindTranscriptToRun(runtimeSystem(), {
        agentId: input.agentId,
        agentRunId: input.agentRunId as AgentRunId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        threadId: input.threadId,
      });
      if (!bound.ok) return bound;
      return b3ok({
        bindingId: String(bound.value.id),
        ...(bound.value.mirrorWatermark === undefined
          ? {} : { mirrorWatermark: bound.value.mirrorWatermark }),
      });
    },

    async finalWatermarkOf(agentRunId: AgentRunId) {
      const custody = transcript();
      if (custody === null) return unavailable();
      const found = await custody.getTranscriptBinding(
        { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] }, agentRunId,
      );
      // A Run with no binding is not a failure: it is a Run whose provider
      // never produced a transcript, and the honest final watermark for it is
      // no watermark at all.
      if (!found.ok) return b3ok({ bindingId: null, finalWatermark: '' });
      return b3ok({
        bindingId: String(found.value.id),
        finalWatermark: found.value.mirrorWatermark ?? '',
      });
    },
  };
}
