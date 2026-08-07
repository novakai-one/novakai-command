/**
 * `ScreenContext` — pass2 §10, added to the Messaging surface by B3V4-AMD-004.
 *
 * What Chris was looking at when he composed a Message, carried with it so the
 * Agent can read it. Advisory data, never execution authority: the type says so
 * in a field that has exactly one legal value, so an implementation cannot ship
 * a context that quietly claims otherwise.
 *
 * Messaging is the SOLE authority for the echo (§10). Both halves of that live
 * here rather than at the wire, so an in-process caller is governed by the same
 * law as a socket one — the rule is the capability's, not the transport's.
 */
import {
  b3fail, b3ok, validationFailed,
  type B3Result, type IsoUtc,
} from "@novakai/foundation/contract";

export const SCREEN_CONTEXT_SOURCES = ["novakai-window", "display", "unavailable"] as const;
export const SCREEN_CONTEXT_SUPPORT = ["snapshot", "query-only", "unavailable"] as const;

export interface ScreenContext {
  readonly captureId: string;
  readonly capturedAt: IsoUtc;
  readonly source: typeof SCREEN_CONTEXT_SOURCES[number];
  readonly support: typeof SCREEN_CONTEXT_SUPPORT[number];
  /** Literal `true`: a context that is not advisory is not a `ScreenContext`. */
  readonly advisoryOnly: true;
  readonly contentRef?: string;
  readonly limitations: readonly string[];
}

/**
 * Where the echo lives on the committed Message.
 *
 * §10 says "persisted verbatim on the committed `Message` inside the
 * `acceptance` StoreOp". `body.fields` IS that StoreOp — it is the same
 * transaction — which is why §8.2's origin-binding fields already ride there
 * (see `core/mirror-fields.ts` for the reasoning, which is identical: a fact
 * that must not be separable from its Message goes inside it, not beside it).
 */
export const SCREEN_CONTEXT_FIELD = "novakai.screenContext";

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Read a caller-supplied context, or refuse it.
 *
 * A malformed context is REFUSED rather than dropped. Dropping it would let a
 * send succeed while silently discarding the screen, leaving the sender
 * believing the Agent can see what they were looking at — the honesty failure
 * that costs more than the refusal ever could.
 */
const isTextList = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isText);

/**
 * Every rule §10 states about the shape, as a list rather than a ladder — so a
 * caller gets told everything that is wrong with their context in one answer,
 * and so adding the next rule is a row rather than another branch.
 *
 * The last row is the amendment's one MUST, and it is the only rule that reads
 * two fields: `unavailable` means no capture exists, so a reference to one
 * alongside it is a contradiction, and accepting it would put a Message on the
 * record claiming evidence that cannot be produced.
 */
const RULES: readonly {
  readonly field: string;
  readonly holds: (body: Readonly<Record<string, unknown>>) => boolean;
  readonly message: string;
}[] = [
  { field: "captureId", holds: (body) => isText(body["captureId"]), message: "must be a non-empty string" },
  { field: "capturedAt", holds: (body) => isText(body["capturedAt"]), message: "must be an ISO-8601 UTC timestamp" },
  {
    field: "source",
    holds: (body) => SCREEN_CONTEXT_SOURCES.includes(body["source"] as ScreenContext["source"]),
    message: `must be one of: ${SCREEN_CONTEXT_SOURCES.join(", ")}`,
  },
  {
    field: "support",
    holds: (body) => SCREEN_CONTEXT_SUPPORT.includes(body["support"] as ScreenContext["support"]),
    message: `must be one of: ${SCREEN_CONTEXT_SUPPORT.join(", ")}`,
  },
  {
    field: "advisoryOnly",
    holds: (body) => body["advisoryOnly"] === true,
    message: "must be true — screen context is never execution authority",
  },
  { field: "limitations", holds: (body) => isTextList(body["limitations"]), message: "must be an array of non-empty strings" },
  {
    field: "contentRef",
    holds: (body) => body["contentRef"] === undefined || isText(body["contentRef"]),
    message: "must be a non-empty string when present",
  },
  {
    field: "contentRef",
    holds: (body) => body["support"] !== "unavailable" || body["contentRef"] === undefined,
    message: 'must be absent when support is "unavailable"',
  },
];

export function readScreenContext(
  candidate: unknown, path = "screenContext",
): B3Result<ScreenContext> {
  const body = (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate))
    ? candidate as Record<string, unknown>
    : null;
  if (body === null) {
    return b3fail(validationFailed([{ path, message: "must be an object" }]));
  }
  const issues = RULES
    .filter((rule) => !rule.holds(body))
    .map((rule) => ({ path: `${path}.${rule.field}`, message: rule.message }));
  if (issues.length > 0) return b3fail(validationFailed(issues));

  const contentRef = body["contentRef"];
  return b3ok({
    captureId: body["captureId"] as string,
    capturedAt: body["capturedAt"] as IsoUtc,
    source: body["source"] as ScreenContext["source"],
    support: body["support"] as ScreenContext["support"],
    advisoryOnly: true,
    ...(contentRef === undefined ? {} : { contentRef: contentRef as string }),
    limitations: [...body["limitations"] as readonly string[]],
  });
}

/**
 * The echo, read back off a committed Message.
 *
 * Returns what was stored, unchanged — no re-validation and no repair. §10 says
 * the projection echoes it UNCHANGED, and a reader that quietly fixed an old
 * record would make the echo a function of when it was read.
 */
export function screenContextOf(
  fields: Readonly<Record<string, unknown>> | undefined,
): ScreenContext | undefined {
  const stored = fields?.[SCREEN_CONTEXT_FIELD];
  return stored === undefined ? undefined : stored as ScreenContext;
}
