/**
 * messagingV2 failure truth (slice N5, D-N5-3): close the agent-side
 * failure-truth gap. PTY agents deliberately don't consume subscription
 * frames (the push lane is an honest no-op), so a terminally failed delivery
 * was visible only in the browser — the SENDER's PTY never heard. This glue
 * subscribes each held lane session to DeliveryUpdated and, on a terminal
 * failure, types ONE `[nvk-msg failed: <reason> — <messageId>]` line into
 * the sender's own lane through the same host submit path the N2 transport
 * uses. One failed delivery = one typed line (dedupe by delivery id across
 * both parties' subscriptions and across replay). A sender with no live
 * lane is dropped quietly — the browser surface still has the truth.
 */

import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import type { SubscriptionHandle } from '../../../../packages/messaging/core/subscriptions.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { personIdForAgentId } from '../authority/index.js';
import { readTrailingPage } from '../rooms/index.js';

export interface FailureTruthDeps {
  terminals: TerminalRuntime;
  log?: (message: string) => void;
}

export interface FailureTruth {
  /** Subscribe one held lane session (idempotent per session). */
  watchSession(session: MessagingSession, agentId: string): void;
  /** Typed failure lines (operability/tests). */
  readonly typedCount: number;
}

interface FailureFrame {
  kind: string;
  event?: {
    sequence?: number;
    delivery?: {
      id: string;
      messageId: string;
      threadId: string;
      state: string;
      stateReason?: string;
    };
  };
}

const SUBMIT_SETTLE_MS = 900;

function announce(deps: FailureTruthDeps, message: string): void {
  (deps.log ?? ((): void => {}))(message);
}

interface FailureState {
  deps: FailureTruthDeps;
  seen: Set<string>;
  watched: Set<string>;
  typed: number;
}

/** The failure line: typed once into the SENDER's own live lane. ORDER
 * MATTERS: the sender guard runs BEFORE the dedupe — a recipient-side
 * subscription sees the same failed delivery and must never consume it
 * (otherwise the sender's own sink is starved, exactly the N5 test case). */
async function typeFailureLine(
  state: FailureState,
  session: MessagingSession,
  agentId: string,
  delivery: { id: string; messageId: string; threadId: string; stateReason?: string },
): Promise<void> {
  const messages = await readTrailingPage(session, delivery.threadId as never);
  const message = messages.find((entry) => entry.id === delivery.messageId);
  if (message === undefined || message.senderId !== personIdForAgentId(agentId)) return;
  if (state.seen.has(delivery.id)) return;
  state.seen.add(delivery.id);
  const reason = delivery.stateReason ?? 'failed';
  state.deps.terminals.submit({
    agentId,
    messageId: `failed_${delivery.id}`,
    text: `[nvk-msg failed: ${reason} — ${delivery.messageId}]`,
    settleMs: SUBMIT_SETTLE_MS,
  });
  state.typed += 1;
}

function sinkFor(state: FailureState, session: MessagingSession, agentId: string) {
  return (frame: FailureFrame) => {
    const delivery = frame.event?.delivery;
    if (frame.kind !== 'event' || delivery === undefined || delivery.state !== 'failed') {
      return Promise.resolve({ kind: 'effect' as const });
    }
    void typeFailureLine(state, session, agentId, delivery).catch((cause: unknown) => {
      announce(state.deps, `[messaging-v2] failure-truth line failed for ${agentId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    return Promise.resolve({ kind: 'effect' as const });
  };
}

export function createFailureTruth(deps: FailureTruthDeps): FailureTruth {
  const state: FailureState = { deps, seen: new Set(), watched: new Set(), typed: 0 };
  return {
    watchSession(session, agentId) {
      const key = session.principal.sessionId;
      if (state.watched.has(key)) return;
      state.watched.add(key);
      void session.subscribe(
        { events: ['DeliveryUpdated'] },
        sinkFor(state, session, agentId) as never,
      ).then((outcome) => {
        if (outcome.kind === 'error') {
          announce(deps, `[messaging-v2] failure-truth subscribe failed for ${agentId}: ${outcome.error.message}`);
        }
        return outcome as SubscriptionHandle | unknown;
      }).catch(() => {
        // best-effort glue — a failed subscription never breaks the lane
      });
    },
    get typedCount(): number {
      return state.typed;
    },
  };
}
