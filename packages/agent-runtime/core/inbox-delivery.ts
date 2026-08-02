// The delivery half of §8.1: an accepted Message becomes keystrokes.
//
// §8.1 gives an inbox item six states and §12.5 publishes the two operations
// that move it — `claimNextInboxItem` and `recordInboxSubmission`, both typed
// to `sys_agent_runtime`, because the Runtime is the only thing that holds a
// terminal to type into. Nothing in production called either. So a Message
// addressed to an Agent was accepted, made durable, announced on the event
// stream, and then sat in `queued` for ever, and exam row E2 — which asks for a
// NAMED submitted/observed state — read an empty list, correctly.
//
// The rules this obeys are §20's, and they are all about not lying:
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
  mintClientOpId, mintTraceCorrelationId,
  type AgentId, type B3Result, type CommandContext, type TerminalSessionId,
} from '@novakai/foundation/contract';

import type { MessagingInboxPort } from '../contract/ports.js';
import type { AgentRun } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';

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

const deliveryContext = (): CommandContext => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

/**
 * A Run that can be typed into right now.
 *
 * `ready` and nothing else: `provisioning` is still climbing the §13.5 ladder
 * with its terminal mid-gate, and every other lifecycle — final or recovering —
 * has no PTY this Runtime may type into.
 */
function deliverable(agentRun: AgentRun): boolean {
  return agentRun.lifecycle === 'ready' && agentRun.terminalSessionId !== undefined;
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
    // The provider lives on the launch plan, not on the Run — read BEFORE the
    // claim, so a plan this host cannot resolve leaves the item `queued` for
    // the next pass rather than `claimed` with nowhere to go.
    const plan = await core.agents.getLaunchPlan(
      { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] }, agentRun.launchPlanId,
    );
    if (!plan.ok) return { delivered: false };

    const claimed = await inbox.claimNext(agentRun.agentId as AgentId);
    if (!claimed.ok) {
      return { delivered: false, failure: { inboxItemId: '', code: claimed.error.code } };
    }
    if (claimed.value === null) return { delivered: false };
    const item = claimed.value;

    const submitted = await core.terminal.submitRuntimeInput(deliveryContext(), {
      terminalSessionId: agentRun.terminalSessionId as TerminalSessionId,
      keystrokes: core.providers.deliverTurn(plan.value.provider, item.text),
      // Derived from the item, so a repeat of THIS delivery is recognised as
      // the same effect rather than typed a second time.
      effectKey: `inbox-delivery:${item.inboxItemId}`,
    });

    if (!submitted.ok) {
      const recorded = await inbox.recordSubmission({
        inboxItemId: item.inboxItemId,
        outcome: 'failed',
        failureReason: `${submitted.error.code}: ${submitted.error.message}`,
      });
      return {
        delivered: false,
        failure: {
          inboxItemId: item.inboxItemId,
          code: recorded.ok ? submitted.error.code : recorded.error.code,
        },
      };
    }

    // §20, in one line: the terminal is the only thing that can say whether the
    // bytes were confirmed, and this records what it said rather than what
    // would be convenient.
    const recorded = await inbox.recordSubmission({
      inboxItemId: item.inboxItemId,
      outcome: submitted.value.confirmed ? 'submitted-confirmed' : 'submitted-unconfirmed',
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
