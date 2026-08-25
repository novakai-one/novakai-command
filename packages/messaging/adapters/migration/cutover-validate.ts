/**
 * §18.1's `LegacyMessagingStoreOpPayload`, promoted to a runtime validator.
 *
 * Split out of `cutover.ts` because parsing is not migrating. This file answers
 * exactly one question — "is this line a legal legacy `StoreOp`?" — and it is the
 * half of the cutover with no filesystem, no handle and no receipt, which is why
 * it can be exercised on a string in a test without a root at all.
 */
import {
  b3err, b3fail, b3ok, type B3Result,
} from "@novakai/foundation/contract";
import { legacyStoreOpNames } from "../store-shared.js";
import type { StoreOp } from "../store-shared.js";

/**
 * §18.1's `LegacyMessagingStoreOpPayload`, promoted to a runtime validator.
 *
 * A legacy line claiming a B3c-only variant is NOT a legacy line — the B3c
 * variants did not exist when that file was written, so a line carrying one is
 * either corruption or someone smuggling endpoint truth in under the fence.
 * Either way it is refused rather than accepted.
 */
export function readLegacyStoreOp(line: string, ordinal: number): B3Result<StoreOp> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return b3fail(b3err("ValidationFailed", `legacy line ${ordinal} is not JSON`,
      { issues: [{ path: `line.${String(ordinal)}`, message: "unparseable" }] }, false));
  }
  if (typeof parsed !== "object" || parsed === null) {
    return b3fail(b3err("ValidationFailed", `legacy line ${ordinal} is not an object`,
      { issues: [{ path: `line.${String(ordinal)}`, message: "not an object" }] }, false));
  }
  const variant = (parsed as { op?: unknown }).op;
  if (typeof variant !== "string"
    || !(legacyStoreOpNames as readonly string[]).includes(variant)) {
    return b3fail(b3err("ValidationFailed",
      `legacy line ${ordinal} carries op "${String(variant)}", which the legacy format never had`,
      { issues: [{ path: `line.${String(ordinal)}.op`, message: "not a carried-forward variant" }] },
      false));
  }
  const shaped = payloadIssues(variant, parsed as Record<string, unknown>);
  if (shaped !== null) {
    return b3fail(b3err("ValidationFailed",
      `legacy line ${ordinal} is a malformed "${variant}": ${shaped}`,
      { issues: [{ path: `line.${String(ordinal)}.${shaped}`, message: "missing or malformed" }] },
      false));
  }
  return b3ok(parsed as StoreOp);
}

/**
 * The rest of the payload, not just the discriminant.
 *
 * §18.1 step 1 says "parses every old line with the promoted public validator
 * covering all seven carried-forward variants". Checking only `op` is not that:
 * a line reading `{"op":"acceptance"}` passed, was wrapped as a Foundation
 * record, and only failed later at replay — by which point the failure names
 * the replay rather than the line that caused it. Worse, a malformed variant
 * that happens to replay identically on both sides (because both sides are
 * equally broken) is silently PROMOTED into the canonical journal.
 *
 * Each rule below is the shape `StoreCore.applyOp` actually dereferences for
 * that variant. Nothing more is asserted, because anything more would reject a
 * legitimate historic line.
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasId = (value: unknown): boolean =>
  isObject(value) && typeof value["id"] === "string" && value["id"] !== "";

const journalEntry = (value: unknown): boolean =>
  isObject(value) && typeof value["sequence"] === "number";

/**
 * The historic acceptance journal is legitimately a singleton OR an array
 * (§8.1, AMD-001 §7). Both are accepted here and normalised afterwards.
 */
const journalShape = (value: unknown): boolean =>
  value === undefined
  || (Array.isArray(value) ? value.every(journalEntry) : journalEntry(value));

/** The acceptance variant, which is the only one with a compound shape. */
function acceptanceIssues(line: Record<string, unknown>): string | null {
  if (!hasId(line["thread"])) return "thread.id";
  if (!hasId(line["message"])) return "message.id";
  if (!hasId(line["snapshot"])) return "snapshot.id";
  // `deliveries` is iterated unconditionally by `applyOp`, so an absent one
  // is a crash at replay rather than an empty result.
  if (!(Array.isArray(line["deliveries"]) && line["deliveries"].every(hasId))) {
    return "deliveries";
  }
  // The acceptance record IS the idempotency key: replay indexes it by
  // (senderId, clientMessageId), and a line missing either would make one
  // migrated Message unfindable by the send that already accepted it.
  const acceptance = line["acceptance"];
  if (!isObject(acceptance)) return "acceptance";
  if (typeof acceptance["senderId"] !== "string") return "acceptance.senderId";
  if (typeof acceptance["clientMessageId"] !== "string") return "acceptance.clientMessageId";
  if (!journalShape(line["journal"])) return "journal";
  return null;
}

/** One rule per variant, each the shape `StoreCore.applyOp` dereferences. */
const VARIANT_RULES: Readonly<Record<string, (line: Record<string, unknown>) => string | null>> = {
  acceptance: acceptanceIssues,
  "room-thread": (line) => (hasId(line["thread"]) ? null : "thread.id"),
  "delivery-transition": (line) => {
    if (!hasId(line["delivery"])) return "delivery.id";
    if (!journalEntry(line["journal"])) return "journal.sequence";
    if (line["attempt"] !== undefined && !hasId(line["attempt"])) return "attempt.id";
    return null;
  },
  attempt: (line) => (hasId(line["attempt"]) ? null : "attempt.id"),
  policy: (line) => {
    if (!isObject(line["contact"]) && !isObject(line["dnd"])) return "contact|dnd";
    if (!journalEntry(line["journal"])) return "journal.sequence";
    return null;
  },
  template: (line) => {
    if (!hasId(line["template"])) return "template.id";
    if (!journalEntry(line["journal"])) return "journal.sequence";
    return null;
  },
  settled: (line) =>
    (typeof line["messageId"] === "string" && line["messageId"] !== "" ? null : "messageId"),
};

function payloadIssues(variant: string, line: Record<string, unknown>): string | null {
  const rule = VARIANT_RULES[variant];
  return rule === undefined ? "op" : rule(line);
}
