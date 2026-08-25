/**
 * requestHash (A5, Store-Seam §2): SHA-256 hex of the full request content —
 * address, body, priority for SendMessage; address, template ID + fields,
 * priority for SendFromTemplate. Computed by the core, compared opaquely by
 * the store inside commitAcceptance. Serialization is key-stable so the same
 * logical request always hashes identically regardless of caller key order.
 *
 * A template send hashes the TEMPLATE request, never the rendered body: a
 * same-key + same-content retry must return the original acceptance even if
 * the template was revised or retired since (DEC-13 — a retry is never
 * re-judged), and a retry whose template fields differ must conflict (A5).
 */

import { createHash } from "node:crypto";

import type { RequestHash } from "../contract/schemas.js";
import type { SendFromTemplateInput, SendMessageInput } from "../contract/schemas.js";

/** Deterministic JSON: object keys sorted recursively; arrays keep order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function hash(canonical: string): RequestHash {
  return createHash("sha256").update(canonical).digest("hex") as RequestHash;
}

export function hashSendRequest(input: SendMessageInput): RequestHash {
  return hash(stableStringify({
    address: input.address,
    body: input.body,
    priority: input.priority,
  }));
}

export function hashSendFromTemplateRequest(input: SendFromTemplateInput): RequestHash {
  return hash(stableStringify({
    address: input.address,
    templateId: input.templateId,
    fields: input.fields,
    priority: input.priority,
  }));
}
