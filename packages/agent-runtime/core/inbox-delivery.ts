// The delivery half of the inbox contract: an accepted Message becomes
// keystrokes.
//
// An inbox item has six states and Messaging publishes the two operations that
// move it — `claimNextInboxItem` and `recordInboxSubmission`, both typed
// to `sys_agent_runtime`, because the Runtime is the only thing that holds a
// terminal to type into. Nothing in production called either. So a Message
// addressed to an Agent was accepted, made durable, announced on the event
// stream, and then sat in `queued` for ever — a consumer asking for a NAMED
// submitted/observed state read an empty list, correctly.
//
// The rules this obeys are all about not lying:
//
//   - only a Run whose endpoint is ACTIVE is delivered to. `claimNext` enforces
//     that on Messaging's side; this only offers Runs that are `ready`, so a
//     Message can never race the skills-gate turn the ladder is still typing;
//   - `submitted-unconfirmed` unless the terminal says confirmed. Keystrokes
//     reaching a PTY is not the provider having read them;
//   - a claimed item is never re-offered. `claimNextInboxItem` hands out
//     `queued` only, so a crash between the write and the record leaves an item
//     a human can see rather than a turn typed twice;
//   - the effect key is derived from the inbox item, so a retry of the same
//     delivery is the same effect rather than a second one.

import {
  deriveClientOpId, mintTraceCorrelationId,
  type AgentId, type B3Result, type CommandContext, type TerminalSessionId,
} from '@novakai/foundation/contract';

import type { MessagingInboxPort } from '../contract/ports.js';
import type { AgentRun } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';
import { submitProviderTurn } from './provider-turns.js';

export interface InboxDeliveryPass {
  readonly considered: number;
  readonly delivered: number;
  readonly failures: readonly { readonly inboxItemId: string; readonly code: string }[];
}

export interface InboxDeliveryPump {
  deliverOnce(): Promise<InboxDeliveryPass>;
  start(): void;
  stop(): Promise<void>;
}

export interface InboxDeliveryOptions {
  readonly core: RunsCore;
  readonly inbox: MessagingInboxPort;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 500;

const EMPTY: InboxDeliveryPass = { considered: 0, delivered: 0, failures: [] };

const deliveryContext = (effectKey: string): CommandContext => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: deriveClientOpId(`agent-inbox-delivery:${effectKey}`),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

/**
 * A Run that can be typed into right now.
 *
 * `ready` and nothing else: `provisioning` is still climbing the spawn ladder
 * with its terminal mid-gate, and every other lifecycle — final or recovering —
 * has no PTY this Runtime may type into.
 */
function deliverable(agentRun: AgentRun): boolean {
  return agentRun.lifecycle === 'ready'
    && agentRun.terminalSessionId !== undefined;
}

export function createInboxDeliveryPump(options: InboxDeliveryOptions): InboxDeliveryPump {
  const { core, inbox } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<InboxDeliveryPass> | null = null;

  /** One item for one Run, from claim to recorded outcome. */
  async function deliverTo(
    agentRun: AgentRun,
  ): Promise<{ delivered: boolean; failure?: { inboxItemId: string; code: string } }> {
    const pending = await inbox.peekNext(agentRun.agentId as AgentId);
    if (!pending.ok) {
      return { delivered: false, failure: { inboxItemId: '', code: pending.error.code } };
    }
    if (pending.value === null) return { delivered: false };
    const item = pending.value;
    const binding = await core.transcriptBinding?.(agentRun.id);
    if (binding === undefined || binding === null) {
      return {
        delivered: false,
        failure: { inboxItemId: item.inboxItemId, code: 'TranscriptSourceUnavailable' },
      };
    }
    const effectKey = `inbox-delivery:${item.inboxItemId}`;

    const submitted = await submitProviderTurn(core, deliveryContext(effectKey), {
      kind: 'runtime-effect',
      source: 'agent-inbox-delivery',
      sourceEffectKey: effectKey,
      sourceObjectRef: item.inboxItemId,
      agentRunId: agentRun.id,
      terminalSessionId: agentRun.terminalSessionId as TerminalSessionId,
      transcriptBindingId: binding.bindingId,
      utf8Text: item.text,
    });

    if (!submitted.ok) {
      return {
        delivered: false,
        failure: { inboxItemId: item.inboxItemId, code: submitted.error.code },
      };
    }
    if (submitted.value.kind === 'queued-not-yet-safe') return { delivered: false };
    if (submitted.value.kind === 'not-submitted') {
      return {
        delivered: false,
        failure: { inboxItemId: item.inboxItemId, code: 'ProviderTurnSubmissionConflict' },
      };
    }

    // Claim only after the semantic owner has crossed the provider boundary.
    // A blocked turn therefore leaves the Messaging item queued exactly where
    // its owner can retry it; a crash here replays the same Runtime submission.
    const claimed = await inbox.claimNext(agentRun.agentId as AgentId);
    if (!claimed.ok) {
      return { delivered: false, failure: { inboxItemId: item.inboxItemId, code: claimed.error.code } };
    }
    if (claimed.value === null || claimed.value.inboxItemId !== item.inboxItemId
      || claimed.value.messageId !== item.messageId || claimed.value.text !== item.text) {
      return {
        delivered: false,
        failure: { inboxItemId: item.inboxItemId, code: 'ProviderTurnSubmissionConflict' },
      };
    }

    // The terminal is the only thing that can say whether the
    // bytes were confirmed, and this records what it said rather than what
    // would be convenient.
    const recorded = await inbox.recordSubmission({
      inboxItemId: item.inboxItemId,
      outcome: submitted.value.kind,
      terminalInputAttemptId: submitted.value.terminalInputAttemptId,
    });
    if (!recorded.ok) {
      return { delivered: false, failure: { inboxItemId: item.inboxItemId, code: recorded.error.code } };
    }
    return { delivered: true };
  }

  async function runPass(): Promise<InboxDeliveryPass> {
    const runs = await core.store.list<AgentRun>('agentRun');
    if (!runs.ok) return { ...EMPTY, failures: [{ inboxItemId: '', code: runs.error.code }] };

    const live = runs.value.filter(deliverable);
    let delivered = 0;
    const failures: { inboxItemId: string; code: string }[] = [];
    for (const agentRun of live) {
      // One item per Run per pass. A burst delivered in a single tick would type
      // several turns into a provider that has not answered the first, which is
      // the one thing a terminal cannot recover from.
      const outcome = await deliverTo(agentRun);
      if (outcome.delivered) delivered += 1;
      if (outcome.failure !== undefined) failures.push(outcome.failure);
    }
    return { considered: live.length, delivered, failures };
  }

  async function deliverOnce(): Promise<InboxDeliveryPass> {
    if (inFlight !== null) return inFlight;
    const started = runPass().finally(() => { inFlight = null; });
    inFlight = started;
    return started;
  }

  return {
    deliverOnce,

    start() {
      if (timer !== null) return;
      timer = setInterval(() => { void deliverOnce(); }, intervalMs);
      timer.unref();
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight !== null) await inFlight;
    },
  };
}
