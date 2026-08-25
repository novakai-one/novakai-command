// Fake Messaging and Transcript, for the ladder rungs B3c owns.
//
// These are FAKES, not stubs that agree with whatever they are asked. Each one
// enforces the rule its real capability enforces, so a Runtime that calls them
// in the wrong order or with the wrong expectation fails here rather than in
// production:
//
//   - a reservation whose `expectedEndpointGeneration` is stale is REFUSED,
//     exactly as Messaging's CAS refuses it;
//   - a claim can only be activated from `reserved`/`active`, drained from a
//     live state, and transferred once from the generation it names;
//   - a binding is get-or-create per Run, and its watermark is whatever was
//     recorded — never invented on read.
import { b3err, b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';
import type {
  HeadlessChildMessagingPort, MessagingEndpointPort, TranscriptCustodyPort,
} from '../contract/ports.js';

export interface FakeHeadlessChildMessaging extends HeadlessChildMessagingPort {
  readonly prepared: Parameters<HeadlessChildMessagingPort['prepare']>[0][];
  readonly dispatched: Parameters<HeadlessChildMessagingPort['dispatchBrief']>[0][];
}

export function createFakeHeadlessChildMessaging(): FakeHeadlessChildMessaging {
  const prepared: FakeHeadlessChildMessaging['prepared'] = [];
  const dispatched: FakeHeadlessChildMessaging['dispatched'] = [];
  return {
    prepared,
    dispatched,
    async prepare(input) {
      prepared.push(input);
      return b3ok({ conversationId: `conversation_${String(input.agentId)}` });
    },
    async dispatchBrief(input) {
      dispatched.push(input);
      return b3ok({ sendId: `send_${String(input.agentId)}` });
    },
  };
}

export interface FakeClaim {
  readonly id: string;
  readonly agentId: string;
  readonly agentRunId: string;
  readonly terminalSessionId: string;
  readonly endpointGeneration: number;
  state: 'reserved' | 'active' | 'draining' | 'closed';
  finalTranscriptWatermark?: string;
}

export interface FakeMessagingEndpoints extends MessagingEndpointPort {
  readonly claims: readonly FakeClaim[];
  readonly threads: ReadonlyMap<string, string>;
}

const conflict = (message: string): B3Result<never> =>
  b3fail(b3err('EndpointClaimConflict', message, {}, true));

export function createFakeMessagingEndpoints(): FakeMessagingEndpoints {
  const claims: FakeClaim[] = [];
  const threads = new Map<string, string>();

  const currentOf = (agentId: string): FakeClaim | null => {
    const live = claims.filter((claim) => claim.agentId === agentId && claim.state !== 'closed');
    return live[live.length - 1] ?? null;
  };
  const generationOf = (agentId: string): number => claims
    .filter((claim) => claim.agentId === agentId)
    .reduce((highest, claim) => Math.max(highest, claim.endpointGeneration), -1);

  return {
    claims,
    threads,

    async ensureAgentThread(input) {
      const pair = `${String(input.rootHumanPrincipalId)}::${String(input.agentId)}`;
      const existing = threads.get(pair);
      if (existing !== undefined) return b3ok({ threadId: existing });
      const threadId = `thread_fake_${String(threads.size + 1).padStart(4, '0')}`;
      threads.set(pair, threadId);
      return b3ok({ threadId });
    },

    async currentEndpoint(agentId) {
      const claim = currentOf(String(agentId));
      return b3ok({
        claimId: claim === null ? null : claim.id,
        endpointGeneration: generationOf(String(agentId)),
      });
    },

    async reserve(input) {
      const actual = generationOf(String(input.agentId));
      if (actual !== input.expectedEndpointGeneration) {
        return conflict(
          `endpoint generation moved: expected ${String(input.expectedEndpointGeneration)}, `
          + `actual ${String(actual)}`,
        );
      }
      const endpointGeneration = actual + 1;
      const claim: FakeClaim = {
        id: `agentEndpoint_fake_${String(input.agentId)}_${String(endpointGeneration)}`,
        agentId: String(input.agentId),
        agentRunId: String(input.agentRunId),
        terminalSessionId: String(input.terminalSessionId),
        endpointGeneration,
        state: 'reserved',
      };
      claims.push(claim);
      return b3ok({ claimId: claim.id, endpointGeneration });
    },

    async activate(claimId) {
      const claim = claims.find((item) => item.id === claimId);
      if (claim === undefined) return conflict(`no endpoint claim ${claimId}`);
      if (claim.state === 'closed') return conflict(`endpoint claim ${claimId} is closed`);
      claim.state = 'active';
      return b3ok({ claimId });
    },

    async drain(claimId) {
      const claim = claims.find((item) => item.id === claimId);
      if (claim === undefined) return conflict(`no endpoint claim ${claimId}`);
      if (claim.state === 'closed') return conflict(`endpoint claim ${claimId} is closed`);
      claim.state = 'draining';
      return b3ok({ claimId });
    },

    async transfer(input) {
      const previous = claims.find((item) => item.id === input.expectedOldClaimId);
      if (previous === undefined) {
        return conflict(`no endpoint claim ${input.expectedOldClaimId} to transfer from`);
      }
      if (previous.endpointGeneration !== input.expectedEndpointGeneration) {
        return conflict('the endpoint moved before this transfer could start');
      }
      previous.state = 'closed';
      previous.finalTranscriptWatermark = input.oldFinalTranscriptWatermark;
      const endpointGeneration = previous.endpointGeneration + 1;
      const next: FakeClaim = {
        id: `agentEndpoint_fake_${String(input.agentId)}_${String(endpointGeneration)}`,
        agentId: String(input.agentId),
        agentRunId: String(input.newRunId),
        terminalSessionId: String(input.newTerminalSessionId),
        endpointGeneration,
        state: 'active',
      };
      claims.push(next);
      return b3ok({ claimId: next.id, endpointGeneration });
    },
  };
}

export interface FakeBinding {
  readonly id: string;
  readonly agentRunId: string;
  readonly threadId: string;
  mirrorWatermark?: string;
}

export interface FakeTranscriptCustody extends TranscriptCustodyPort {
  readonly bindings: readonly FakeBinding[];
  /** Move a binding's watermark, so a continuation has a real one to commit. */
  setWatermark(agentRunId: string, watermark: string): void;
}

export function createFakeTranscriptCustody(): FakeTranscriptCustody {
  const bindings: FakeBinding[] = [];
  return {
    bindings,

    setWatermark(agentRunId, watermark) {
      const found = bindings.find((binding) => binding.agentRunId === agentRunId);
      if (found !== undefined) found.mirrorWatermark = watermark;
    },

    async bind(input) {
      const existing = bindings.find(
        (binding) => binding.agentRunId === String(input.agentRunId),
      );
      if (existing !== undefined) {
        return b3ok({
          bindingId: existing.id,
          ...(existing.mirrorWatermark === undefined
            ? {} : { mirrorWatermark: existing.mirrorWatermark }),
        });
      }
      const binding: FakeBinding = {
        id: `transcriptBinding_fake_${String(bindings.length + 1).padStart(4, '0')}`,
        agentRunId: String(input.agentRunId),
        threadId: input.threadId,
      };
      bindings.push(binding);
      return b3ok({ bindingId: binding.id });
    },

    async finalWatermarkOf(agentRunId) {
      const found = bindings.find((binding) => binding.agentRunId === String(agentRunId));
      if (found === undefined) return b3ok({ bindingId: null, finalWatermark: '' });
      return b3ok({
        bindingId: found.id,
        finalWatermark: found.mirrorWatermark ?? '',
      });
    },
  };
}
