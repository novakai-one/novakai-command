/**
 * requestHash (A5, Store-Seam §2): SHA-256 hex of the full request content —
 * address, body, priority (template ID + fields when SendFromTemplate lands in
 * S4). Computed by the core, compared opaquely by the store inside
 * commitAcceptance. Serialization is key-stable so the same logical request
 * always hashes identically regardless of caller key order.
 */

import { createHash } from "node:crypto";

import type { RequestHash } from "../public/contract/index.js";
import type { SendMessageInput } from "../public/contract/index.js";

/** Deterministic JSON: object keys sorted recursively; arrays keep order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function hashSendRequest(input: SendMessageInput): RequestHash {
  const canonical = stableStringify({
    address: input.address,
    body: input.body,
    priority: input.priority,
  });
  return createHash("sha256").update(canonical).digest("hex") as RequestHash;
}
