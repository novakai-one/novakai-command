/**
 * protocol/frames — DEC-17: the versioned JSON-over-WebSocket protocol
 * (protocolVersion 1.0.0), standalone mode's inbound wire format.
 *
 * These are ADAPTER types — transport envelopes, NOT the contract. Contract
 * shapes cross unchanged: command/query inputs and results, the
 * SubscriptionMessage stream (started/event/ended, carrying subscriptionId),
 * and the 13-error catalogue. This file adds only what the wire needs:
 * request-id correlation, the auth handshake, and the addressed-lane
 * delivery push frame.
 *
 * Stream discipline (R1): a successful Subscribe is acknowledged BY the
 * stream itself — the `started` frame carries the subscriptionId. Failures
 * before the stream opens are ordinary `error` frames correlated by
 * requestId. There is deliberately no separate "subscribed" ack: control
 * frames are part of the stream.
 *
 * MSG-021: every inbound frame is parsed from `unknown` here; malformed
 * frames produce a typed ValidationFailed error frame and NEVER throw or
 * kill the connection.
 */


import type {
  CapabilityView,
  Grant,
  Message,
  PersonId,
  PresenceId,
  Priority,
  SubscriptionId,
  Timestamp,
} from "../schemas.js";

export const WS_PROTOCOL_VERSION = "1.0.0";

// --- client → server ------------------------------------------------------------

/** The full 8-command surface over the wire (S4 sealed). */
export const wsCommandNames = [
  "OpenPresence",
  "ClosePresence",
  "SendMessage",
  "SendFromTemplate",
  "SetDndPolicy",
  "SetContactPolicy",
  "UpsertTemplate",
  "RetireTemplate",
] as const;
export type WsCommandName = (typeof wsCommandNames)[number];

/** The full query surface (GetCapabilities has its own pre-auth frame). */
export const wsQueryNames = [
  "GetThread",
  "ListThreadsForPerson",
  "GetMessages",
  "GetInbox",
  "GetDelivery",
  "GetPolicy",
  "ListTemplates",
  "GetPresence",
] as const;
export type WsQueryName = (typeof wsQueryNames)[number];

export interface GetCapabilitiesFrame {
  kind: "get-capabilities";
}

/** The auth handshake (carries credentials + optional protocol version negotiation). */
export interface AuthenticateFrame {
  kind: "authenticate";
  requestId: string;
  credential: unknown;
  protocolVersion?: string;
}

export interface CommandFrame {
  kind: "command";
  requestId: string;
  name: WsCommandName;
  input: unknown;
}

export interface QueryFrame {
  kind: "query";
  requestId: string;
  name: WsQueryName;
  input: unknown;
}

/** input is a SubscribeInput — validated by the CORE door parser, not here. */
export interface SubscribeFrame {
  kind: "subscribe";
  requestId: string;
  input: unknown;
}

export interface UnsubscribeFrame {
  kind: "unsubscribe";
  subscriptionId: SubscriptionId;
}

export type ClientFrame =
  | GetCapabilitiesFrame
  | AuthenticateFrame
  | CommandFrame
  | QueryFrame
  | SubscribeFrame
  | UnsubscribeFrame;

// --- server → client ------------------------------------------------------------

export interface CapabilitiesFrame {
  kind: "capabilities";
  capabilities: CapabilityView;
}

export interface AuthenticatedFrame {
  kind: "authenticated";
  requestId: string;
  principal: { personId: PersonId; grants: Grant[]; expiresAt: Timestamp };
}

export interface CommandResultFrame {
  kind: "command-result";
  requestId: string;
  name: WsCommandName;
  result: unknown;
}

export interface QueryResultFrame {
  kind: "query-result";
  requestId: string;
  name: WsQueryName;
  result: unknown;
}

/** ADDRESSED lane (R2): a Delivery's transport effect — the message on the socket. */
export interface DeliveryFrame {
  kind: "delivery";
  message: Message;
  priority: Priority;
  /** The Presence this effect landed on (DEC-16 fan-out evidence). */
  presenceId: PresenceId;
}

export interface ErrorFrameBody {
  name: string;
  message: string;
  retryable: boolean;
  fields: Record<string, unknown>;
}

export interface ErrorFrame {
  kind: "error";
  requestId?: string;
  error: ErrorFrameBody;
}

/** SubscriptionMessage frames (started/event/ended) cross verbatim — they are contract shapes. */
export type ServerFrame =
  | CapabilitiesFrame
  | AuthenticatedFrame
  | CommandResultFrame
  | QueryResultFrame
  | DeliveryFrame
  | ErrorFrame;


/** Event kinds re-exported from the generated contract. */
export { subscribeInputEventsValues } from "../schemas.js";
