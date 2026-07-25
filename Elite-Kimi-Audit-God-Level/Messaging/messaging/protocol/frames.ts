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

import { MessagingError, subscribeInputEventsValues } from "../public/contract/index.js";
import type {
  CapabilityView,
  Grant,
  Message,
  PersonId,
  PresenceId,
  Priority,
  SubscriptionId,
  Timestamp,
  ValidationIssue,
} from "../public/contract/index.js";

export const WS_PROTOCOL_VERSION = "1.0.0";

// --- client → server ------------------------------------------------------------

/** S1 slice surface over the wire (SendFromTemplate/Upsert/Retire land in S4). */
export const wsCommandNames = [
  "OpenPresence",
  "ClosePresence",
  "SendMessage",
  "SetDndPolicy",
  "SetContactPolicy",
] as const;
export type WsCommandName = (typeof wsCommandNames)[number];

/** S1 query surface (GetCapabilities has its own pre-auth frame). */
export const wsQueryNames = [
  "GetThread",
  "GetMessages",
  "GetInbox",
  "GetDelivery",
  "GetPolicy",
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

// --- parsing (MSG-021: from unknown, typed outcomes, never throws) ----------------

export type FrameParseResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; error: MessagingError; requestId?: string };

function validationFailed(issues: ValidationIssue[]): MessagingError {
  return new MessagingError("ValidationFailed", {
    message: `validation failed: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    retryable: false,
    fields: { issues },
  });
}

const KNOWN_KINDS = [
  "get-capabilities",
  "authenticate",
  "command",
  "query",
  "subscribe",
  "unsubscribe",
] as const;

function readRequestId(record: Record<string, unknown>, issues: ValidationIssue[]): string | undefined {
  const raw = record["requestId"];
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) {
    issues.push({ path: "requestId", message: "expected string of length 1..128" });
    return undefined;
  }
  return raw;
}

const SUBSCRIPTION_ID_PATTERN = /^subscription_[A-Za-z0-9-]+$/;

/**
 * Parse one inbound frame (already JSON-parsed by the transport). Malformed
 * frames are a typed ValidationFailed — the requestId is extracted when
 * possible so the error frame stays correlated.
 */
export function parseClientFrame(value: unknown): FrameParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: validationFailed([{ path: "$", message: "expected a JSON object frame" }]),
    };
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : undefined;

  if (typeof kind !== "string" || !(KNOWN_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      error: validationFailed([
        { path: "kind", message: `expected one of ${KNOWN_KINDS.join(" | ")}` },
      ]),
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }

  const issues: ValidationIssue[] = [];
  switch (kind) {
    case "get-capabilities":
      return { ok: true, frame: { kind: "get-capabilities" } };

    case "authenticate": {
      const id = readRequestId(record, issues);
      if (!("credential" in record)) issues.push({ path: "credential", message: "required" });
      const protocolVersion = record["protocolVersion"];
      if (protocolVersion !== undefined && typeof protocolVersion !== "string") {
        issues.push({ path: "protocolVersion", message: "expected string" });
      }
      if (issues.length > 0) {
        return { ok: false, error: validationFailed(issues), ...(requestId !== undefined ? { requestId } : {}) };
      }
      return {
        ok: true,
        frame: {
          kind: "authenticate",
          requestId: id as string,
          credential: record["credential"],
          ...(typeof protocolVersion === "string" ? { protocolVersion } : {}),
        },
      };
    }

    case "command": {
      const id = readRequestId(record, issues);
      const name = record["name"];
      if (typeof name !== "string" || !(wsCommandNames as readonly string[]).includes(name)) {
        issues.push({
          path: "name",
          message: `expected one of ${wsCommandNames.join(" | ")} (this slice's surface)`,
        });
      }
      if (!("input" in record)) issues.push({ path: "input", message: "required" });
      if (issues.length > 0) {
        return { ok: false, error: validationFailed(issues), ...(requestId !== undefined ? { requestId } : {}) };
      }
      return {
        ok: true,
        frame: { kind: "command", requestId: id as string, name: name as WsCommandName, input: record["input"] },
      };
    }

    case "query": {
      const id = readRequestId(record, issues);
      const name = record["name"];
      if (typeof name !== "string" || !(wsQueryNames as readonly string[]).includes(name)) {
        issues.push({
          path: "name",
          message: `expected one of ${wsQueryNames.join(" | ")} (this slice's surface)`,
        });
      }
      const input = "input" in record ? record["input"] : {};
      if (issues.length > 0) {
        return { ok: false, error: validationFailed(issues), ...(requestId !== undefined ? { requestId } : {}) };
      }
      return {
        ok: true,
        frame: { kind: "query", requestId: id as string, name: name as WsQueryName, input },
      };
    }

    case "subscribe": {
      const id = readRequestId(record, issues);
      if (!("input" in record)) issues.push({ path: "input", message: "required" });
      if (issues.length > 0) {
        return { ok: false, error: validationFailed(issues), ...(requestId !== undefined ? { requestId } : {}) };
      }
      return {
        ok: true,
        frame: { kind: "subscribe", requestId: id as string, input: record["input"] },
      };
    }

    case "unsubscribe": {
      const subscriptionId = record["subscriptionId"];
      if (typeof subscriptionId !== "string" || !SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
        issues.push({ path: "subscriptionId", message: "expected SubscriptionId (subscription_…)" });
      }
      if (issues.length > 0) {
        return { ok: false, error: validationFailed(issues), ...(requestId !== undefined ? { requestId } : {}) };
      }
      return { ok: true, frame: { kind: "unsubscribe", subscriptionId: subscriptionId as SubscriptionId } };
    }

    default:
      // Unreachable (kind was membership-checked above) — kept so the
      // function has a total typed outcome even under future kind additions.
      return {
        ok: false,
        error: validationFailed([{ path: "kind", message: "unsupported frame kind" }]),
        ...(requestId !== undefined ? { requestId } : {}),
      };
  }
}

/** Serialize a typed error into the wire error frame (13-error catalogue names cross unchanged). */
export function errorFrame(error: MessagingError, requestId?: string): ErrorFrame {
  return {
    kind: "error",
    ...(requestId !== undefined ? { requestId } : {}),
    error: {
      name: error.name,
      message: error.message,
      retryable: error.retryable,
      fields: error.fields,
    },
  };
}

/** The subscribe-input event kinds, re-exported for the protocol doc/tests (single source: generated). */
export { subscribeInputEventsValues };
