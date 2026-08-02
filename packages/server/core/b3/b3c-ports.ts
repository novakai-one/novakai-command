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
  b3ok, mintClientOpId, mintTraceCorrelationId,
  type AgentId, type AgentRunId, type B3Result, type CommandContext,
  type HumanPrincipalId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  MessagingEndpointPort, TranscriptCustodyPort,
} from '../../../agent-runtime/contract/index.js';
import type {
  AgentEndpointClaimId, AgentMessagingContract,
  AgentId as MessagingAgentId, AgentRunId as MessagingAgentRunId,
  TerminalSessionId as MessagingTerminalSessionId,
} from '../../../messaging/b3/contract/index.js';
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

/** Transcript, narrowed to custody: bind this Run, and say how far it got. */
export function transcriptCustodyPort(
  transcript: () => B3TranscriptContract | null,
): TranscriptCustodyPort {
  const unavailable = (): B3Result<never> => ({
    ok: false,
    error: {
      code: 'RuntimeUnavailable',
      message: 'no Transcript capability is composed in this host',
      details: { reason: 'transcript-not-composed' },
      retryable: false,
    },
  });

  return {
    async bind(input) {
      const api = transcript();
      if (api === null) return unavailable();
      const bound = await api.bindTranscriptToRun(runtimeSystem(), {
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
      const api = transcript();
      if (api === null) return unavailable();
      const found = await api.getTranscriptBinding(
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
