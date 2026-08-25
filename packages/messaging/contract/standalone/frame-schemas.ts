/** Runtime validation for standalone client frames. */

import { MessagingError } from "../schemas.js";
import type { SubscriptionId, ValidationIssue } from "../schemas.js";
import {
  wsCommandNames,
  wsQueryNames,
} from "./frames.js";
import type {
  ClientFrame,
  ErrorFrame,
  WsCommandName,
  WsQueryName,
} from "./frames.js";

export type FrameParseResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; error: MessagingError; requestId?: string };

function validationFailed(issues: ValidationIssue[]): MessagingError {
  return new MessagingError("ValidationFailed", {
    message: `validation failed: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
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

function readRequestId(
  record: Record<string, unknown>,
  issues: ValidationIssue[],
): string | undefined {
  const raw = record["requestId"];
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) {
    issues.push({ path: "requestId", message: "expected string of length 1..128" });
    return undefined;
  }
  return raw;
}

const SUBSCRIPTION_ID_PATTERN = /^subscription_[A-Za-z0-9-]+$/;

/** Parse one already-JSON-decoded inbound frame. */
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
        issues.push({ path: "name", message: `expected one of ${wsCommandNames.join(" | ")}` });
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
        issues.push({ path: "name", message: `expected one of ${wsQueryNames.join(" | ")}` });
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
      return { ok: true, frame: { kind: "subscribe", requestId: id as string, input: record["input"] } };
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
      return {
        ok: false,
        error: validationFailed([{ path: "kind", message: "unsupported frame kind" }]),
        ...(requestId !== undefined ? { requestId } : {}),
      };
  }
}

/** Serialize a typed error into the standalone wire envelope. */
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
