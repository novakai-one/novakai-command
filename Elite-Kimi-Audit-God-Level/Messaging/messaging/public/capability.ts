/**
 * The embedded capability interface — what a host gets from
 * createEmbeddedMessaging (composition/embedded.ts). This file is part of the
 * public contract surface: commands and queries mirror
 * contract/messaging-contract.json; every method parses its input from
 * `unknown` at the door (MSG-021) and returns a typed Outcome — never a
 * leaked implementation exception.
 *
 * Identity rule (DEC-11, G3): no method takes a sender/from — every command
 * executes as the session's authenticated Principal.
 *
 * S2 surface: the direct lane + rooms (membership-resolved sends, frozen
 * recipient snapshots, room read authorization, ListThreadsForPerson) + the
 * Subscribe stream (R1). Absent (not stubbed): SendFromTemplate,
 * UpsertTemplate, RetireTemplate, ListTemplates (S4).
 */

import type { MessagingError } from "./contract/index.js";
import type {
  CapabilityView,
  DeliveryListResult,
  MessagePage,
  PolicyUpdated,
  PolicyView,
  PresenceClosed,
  PresenceListResult,
  PresenceOpened,
  SendAccepted,
  ThreadListResult,
  ThreadView,
} from "./contract/index.js";

// Re-exported so hosts see one surface. The seam types are the documented
// adapter-extension points (Plan §14: adapters are replaceable).
export type { ClockIds } from "../seams/clock.js";
export type { MessagingStore } from "../seams/store.js";
export type {
  Authority,
  Principal,
  ProvisioningDirectory,
  AuthOutcome,
  RevalidateOutcome,
} from "../seams/authority.js";
export type {
  PresenceTransport,
  EffectReport,
  TransportLivenessCallbacks,
  RetryPolicy,
  Scheduler,
} from "../seams/presenceTransport.js";
// The membership seam (Messaging-Seams §3): room/roster truth crosses HERE,
// never from core config — adapters are replaceable (Plan §14).
export type {
  MembershipSource,
  RoomRef,
  ResolveMembersOutcome,
  IsMemberOutcome,
  UnknownRoomError,
} from "../seams/membership.js";
// The Subscribe stream's host-facing types (R1): the sink is the host's push
// lane (embedded: a callback; standalone: bound to transport.push — same
// core, no per-mode business logic).
export type {
  SubscriptionSink,
  SubscriptionHandle,
  SubscriptionBinding,
} from "../core/subscriptions.js";

import type { Principal } from "../seams/authority.js";
import type {
  SubscriptionBinding,
  SubscriptionHandle,
  SubscriptionSink,
} from "../core/subscriptions.js";

/** The door's outcome shape: typed outcomes, never leaked exceptions. */
export type Outcome<T> = { kind: "ok"; value: T } | { kind: "error"; error: MessagingError };

export type SessionState = "active" | "degraded" | "ended";

/**
 * An authenticated session. Every method enforces the §2.1 revalidation
 * state machine (active / degraded / ended) before executing.
 */
export interface MessagingSession {
  readonly principal: Principal;
  readonly state: SessionState;
  /** Explicit revalidation trigger (§2.1: the composition root owns revalidation). */
  revalidate(): Promise<SessionState>;

  // --- commands (S1-b) -------------------------------------------------------
  sendMessage(input: unknown): Promise<Outcome<SendAccepted>>;
  openPresence(input: unknown): Promise<Outcome<PresenceOpened>>;
  closePresence(input: unknown): Promise<Outcome<PresenceClosed>>;
  setDndPolicy(input: unknown): Promise<Outcome<PolicyUpdated>>;
  setContactPolicy(input: unknown): Promise<Outcome<PolicyUpdated>>;

  // --- queries (S2: 7 of the 9; ListTemplates lands in S4) ---------------------
  getThread(input: unknown): Promise<Outcome<ThreadView>>;
  listThreadsForPerson(input: unknown): Promise<Outcome<ThreadListResult>>;
  getMessages(input: unknown): Promise<Outcome<MessagePage>>;
  getInbox(input: unknown): Promise<Outcome<MessagePage>>;
  getDelivery(input: unknown): Promise<Outcome<DeliveryListResult>>;
  getPolicy(input: unknown): Promise<Outcome<PolicyView>>;
  getPresence(input: unknown): Promise<Outcome<PresenceListResult>>;

  // --- the Subscribe stream (R1, S1-c) -----------------------------------------
  /**
   * Attach a subscription: started → event* → ended frames flow to `sink`.
   * The sink reports push outcomes (Seams §4.2): resolve {kind:"effect"} when
   * the frame reached the consumer; a transient failure parks the frame for
   * retry; a permanent failure ends the subscription. Input is parsed from
   * `unknown` at the door like every other operation. `binding` ties the
   * subscription to one of the session's own live Presences for the §4.1
   * teardown (standalone mode binds the connection's Presence).
   */
  subscribe(
    input: unknown,
    sink: SubscriptionSink,
    binding?: SubscriptionBinding,
  ): Promise<Outcome<SubscriptionHandle>>;
}

export type EmbeddedAuthOutcome =
  | { kind: "authenticated"; principal: Principal; session: MessagingSession }
  | { kind: "rejected"; error: MessagingError }
  | { kind: "unavailable"; error: MessagingError };
