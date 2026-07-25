/**
 * The Subscribe stream operation (R1), mirroring contract/messaging-contract.json
 * `subscriptions` and $defs.SubscribeInput / SubscriptionMessage exactly.
 *
 * Control frames are part of the stream — subscription lifecycle never touches
 * the command error catalogue. Every frame carries subscriptionId.
 */

import type {
  Cursor,
  Sequence,
  SubscribeInputEvents,
  SubscriptionEndedKind,
  SubscriptionEndedReason,
  SubscriptionEventFrameKind,
  SubscriptionId,
  SubscriptionStartedKind,
  ThreadId,
} from "./generated.js";

export interface SubscribeInput {
  events: SubscribeInputEvents[];
  /**
   * Optional scope. Empty/absent = all threads the subscriber may read (R3).
   * An explicit list naming an unreadable Thread fails the whole Subscribe
   * with NotAuthorized — scope is never silently dropped (G6).
   */
  threads?: ThreadId[];
  /** Optional resume cursor. Replay = committed-fact events with sequence > cursor, then live (R1). */
  since?: Cursor;
}

export interface SubscriptionStartedFrame {
  kind: SubscriptionStartedKind;
  subscriptionId: SubscriptionId;
  replayedFrom?: Cursor;
}

export interface SubscriptionEventFrame {
  kind: SubscriptionEventFrameKind;
  subscriptionId: SubscriptionId;
  /** Present on committed-fact events; absent on PresenceChanged (observation, R11). */
  sequence?: Sequence;
  /** The event payload — one of the interfaces in ./events.ts. */
  event: Record<string, unknown>;
}

export interface SubscriptionEndedFrame {
  kind: SubscriptionEndedKind;
  subscriptionId: SubscriptionId;
  reason: SubscriptionEndedReason;
}

export type SubscriptionMessage =
  | SubscriptionStartedFrame
  | SubscriptionEventFrame
  | SubscriptionEndedFrame;
