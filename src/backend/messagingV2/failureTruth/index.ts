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
 *
 * F2: the subscription is LIVE-ONLY — it opens with a `since` cursor at the
 * journal tip captured when the watch starts (the app-owned journal read
 * fold, on demand), so a backend restart never re-types historical failures
 * (and never pays an O(all-pages) trailing read per replayed failure). The
 * cursor is computed, never persisted — live-only is the semantic.
 * F4: with live-only subscriptions the "message left the trailing window"
 * drop is rare (recovery sweeps/races) — it leaves a log line now.
 */

import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import type { SubscriptionHandle } from '../../../../packages/messaging/core/subscriptions.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import { personIdForAgentId } from '../authority/index.js';
import { readTrailingPage } from '../rooms/index.js';
import { defaultCapabilityJournalPath, journalTipSequence } from '../journal/index.js';

export interface FailureTruthDeps {
  terminals: TerminalRuntime;
  log?: (message: string) => void;
  /** F2: journal tip at watch start; defaults to the app-owned journal fold. */
  tipSequence?: () => number;
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
  /** F2: journal tip captured once, at the first watched session (null = not yet). */
  tipSeq: number | null;
}

/** F2: the tip is read once per watch — every lane subscription opens at the
 * same live-only cursor; facts committed after it are legitimately new. */
function currentTip(state: FailureState): number {
  if (state.tipSeq === null) {
    state.tipSeq = (state.deps.tipSequence ?? (() => journalTipSequence(defaultCapabilityJournalPath())))();
  }
  return state.tipSeq;
}

/** The trailing-window lookup. F4: a message that aged out leaves a trace
 * (rare under F2's live-only subscription); a message owned by ANOTHER
 * sender returns null quietly (the recipient-side view, the normal case). */
async function ownMessageOrLogged(
  state: FailureState,
  session: MessagingSession,
  agentId: string,
  delivery: { messageId: string; threadId: string },
) {
  const messages = await readTrailingPage(session, delivery.threadId as never);
  const message = messages.find((entry) => entry.id === delivery.messageId);
  if (message !== undefined) return message.senderId === personIdForAgentId(agentId) ? message : null;
  announce(state.deps, `[messaging-v2] failure-truth: message ${delivery.messageId} left the trailing window — line dropped`);
  return null;
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
  if ((await ownMessageOrLogged(state, session, agentId, delivery)) === null) return;
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

function watchSession(state: FailureState, session: MessagingSession, agentId: string): void {
  const sessionKey = session.principal.sessionId;
  if (state.watched.has(sessionKey)) return;
  state.watched.add(sessionKey);
  const tipAtStart = currentTip(state);
  void session.subscribe(
    { events: ['DeliveryUpdated'], ...(tipAtStart > 0 ? { since: `s_${tipAtStart}` } : {}) },
    sinkFor(state, session, agentId) as never,
  ).then((outcome) => {
    if (outcome.kind === 'error') {
      announce(state.deps, `[messaging-v2] failure-truth subscribe failed for ${agentId}: ${outcome.error.message}`);
    }
    return outcome as SubscriptionHandle | unknown;
  }).catch(() => {
    // best-effort glue — a failed subscription never breaks the lane
  });
}

export function createFailureTruth(deps: FailureTruthDeps): FailureTruth {
  const state: FailureState = { deps, seen: new Set(), watched: new Set(), typed: 0, tipSeq: null };
  return {
    watchSession: (session, agentId) => watchSession(state, session, agentId),
    get typedCount(): number {
      return state.typed;
    },
  };
}
