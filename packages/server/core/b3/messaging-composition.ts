// Wiring Messaging and Transcript into the background Runtime (§12.5, §18.1).
//
// Server composes and transports. It owns no Message, no binding and no
// endpoint — it holds the two capability contracts and the ONE narrow port
// between them, which is the only place Transcript and Messaging meet.
import { b3ok } from '@novakai/foundation/contract';
import { createSystemClock } from '../../../messaging/adapters/clock-system.js';
import { openFoundationMessagingStore } from '../../../messaging/b3/adapters/store-foundation.js';
import { composeAgentMessaging } from '../../../messaging/b3/core/compose.js';
import type { AgentMessagingContract } from '../../../messaging/b3/contract/api.js';
import type { MessagingStore } from '../../../messaging/seams/store.js';
import { composeB3Transcript } from '../../../transcript/b3/core/compose.js';
import { createTranscriptStore } from '../../../transcript/b3/core/store.js';
import type {
  B3TranscriptContract, SourceReadOutcome, TranscriptSourcePort,
} from '../../../transcript/b3/contract/api.js';
import type { MessagingMirrorPort } from '../../../transcript/b3/core/mirror.js';
import type { AgentId } from '../../../messaging/b3/contract/records.js';

export type CapabilityEmit = (
  kind: string, payload: Readonly<Record<string, unknown>>,
) => void;

export interface B3MessagingCompositionOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly emit: CapabilityEmit;
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
  const capability = composeAgentMessaging({ store, clock, emit: options.emit });
  return { ...capability, store };
}

export interface B3TranscriptCompositionOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly messaging: AgentMessagingContract;
  readonly emit: CapabilityEmit;
  readonly source?: TranscriptSourcePort;
}

/**
 * A source that reports every binding as `missing`.
 *
 * Used when no provider-file reader is wired. It is deliberately explicit
 * rather than a no-op success: §25-B3c wants bound/waiting/missing and never
 * silence, and a host with no reader genuinely cannot see the source.
 */
const NO_SOURCE: TranscriptSourcePort = {
  async read(): Promise<SourceReadOutcome> { return { kind: 'missing' }; },
};

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
    source: options.source ?? NO_SOURCE,
    messaging: mirror,
    emit: options.emit,
  });
}
