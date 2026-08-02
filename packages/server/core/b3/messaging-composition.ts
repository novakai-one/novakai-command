// Wiring Messaging and Transcript into the background Runtime (§12.5, §18.1).
//
// Server composes and transports. It owns no Message, no binding and no
// endpoint — it holds the two capability contracts and the ONE narrow port
// between them, which is the only place Transcript and Messaging meet.
import { b3ok } from '@novakai/foundation/contract';
import {
  composeAgentMessaging, createSystemClock, openFoundationMessagingStore,
  type AgentDirectoryPort, type AgentId, type AgentMessagingContract,
  type MessagingStore,
} from '../../../messaging/b3/contract/index.js';
import { createFoundationConversationViews } from './conversation-views.js';
import {
  composeB3Transcript, createTranscriptStore,
  type B3TranscriptContract, type MessagingMirrorPort,
  type TranscriptSourcePort,
} from '../../../transcript/b3/contract/index.js';

export type CapabilityEmit = (
  kind: string, payload: Readonly<Record<string, unknown>>,
) => void;

export interface B3MessagingCompositionOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly emit: CapabilityEmit;
  /**
   * Who exists. Messaging does not own Agent identity (§3.3) and refuses a send
   * to an unknown Agent by ASKING, so the composition root supplies the answer.
   */
  readonly agents: AgentDirectoryPort;
}

export interface ComposedMessaging {
  readonly api: AgentMessagingContract;
  readonly store: MessagingStore;
}

/**
 * Messaging's production composition: the Foundation-backed journal and the
 * v1 system clock.
 *
 * The seeded clock stays where it belongs — in tests. Production ids are 128
 * bits of randomness, and production `createdAt` is the real wall clock;
 * ordering is the store sequence either way, never a timestamp (DEC-19).
 */
export async function composeB3Messaging(
  options: B3MessagingCompositionOptions,
): Promise<AgentMessagingContract & { readonly store: MessagingStore }> {
  const clock = createSystemClock();
  const store = await openFoundationMessagingStore(clock, {
    root: options.root, dataRoot: options.dataRoot,
  });
  const capability = composeAgentMessaging({
    store,
    clock,
    emit: options.emit,
    agents: options.agents,
    // Shell owns the `conversationView` kind, so production hands Messaging the
    // real Shell-backed port. Without it Messaging fell back to the in-memory
    // default meant for headless hosts, and a deliberately opened Conversation
    // died with the process.
    conversationViews: createFoundationConversationViews({
      root: options.root, dataRoot: options.dataRoot,
    }),
  });
  return { ...capability, store };
}

export interface B3TranscriptCompositionOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly messaging: AgentMessagingContract;
  readonly emit: CapabilityEmit;
  /**
   * Required, not optional. It was optional, defaulting to a port that reported
   * every binding `missing`, and the production composition never passed one —
   * so no managed Run could mirror a single turn. The composition root now
   * chooses between the real provider-file reader and a test fixture, and
   * neither choice can be made by forgetting.
   */
  readonly source: TranscriptSourcePort;
}

export function composeB3TranscriptFor(
  options: B3TranscriptCompositionOptions,
): B3TranscriptContract {
  const store = createTranscriptStore({
    root: options.root, dataRoot: options.dataRoot,
  });

  // The one door between Transcript and Messaging. Transcript never writes a
  // Message; it asks, and Messaging decides what that means (§3.3).
  const mirror: MessagingMirrorPort = {
    async commitTerminalOriginatedMessage(input) {
      const committed = await options.messaging.commitTerminalOriginatedMessage({
        principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
        clientOpId: `op_${input.turn.transcriptLineId.slice(-36)}` as never,
        traceId: 'trace_00000000-0000-4000-8000-000000000000' as never,
        contractVersion: 1,
      }, {
        bindingId: input.bindingId as never,
        agentId: input.agentId as AgentId,
        threadId: input.threadId as never,
        sourceEndpointClaimId: input.sourceEndpointClaimId as never,
        turn: input.turn as never,
      });
      if (!committed.ok) return committed;
      return b3ok({
        messageId: committed.value.messageId,
        duplicate: committed.value.duplicate,
      });
    },

    async currentEndpointClaimId(agentId) {
      const endpoint = await options.messaging.getAgentEndpoint(
        { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
        agentId as AgentId,
      );
      if (!endpoint.ok) return null;
      return endpoint.value.claim?.id ?? null;
    },
  };

  return composeB3Transcript({
    store,
    source: options.source,
    messaging: mirror,
    emit: options.emit,
  });
}
