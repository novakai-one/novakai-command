/**
 * Messaging's route cutover — B3V4-P2 §8.1, §18.1, DEC-B3V4-25/33.
 *
 * The old `store-jsonl` file cannot be byte-copied the way every other legacy
 * store can: its lines are bare `StoreOp` values, not Foundation `RecordLine`
 * values. So this converts, and the conversion is deliberately the smallest
 * one that can be correct:
 *
 *   - parse every line with the promoted validator, all SEVEN carried-forward
 *     variants and nothing else;
 *   - normalise exactly two things on legacy `acceptance` ops — add
 *     `agentInboxItems: []`, and turn `journal: entry` into `journal: [entry]`;
 *   - keep the source-line ordinal as `storeSequence`;
 *   - replay both journals and require SEMANTIC EQUALITY before anything is
 *     allowed to depend on the result.
 *
 * No other payload change is permitted, and the source file is never written,
 * moved or truncated. It stays as read-only evidence.
 *
 * The gate is the point. A migration that "succeeded" but produced a different
 * StoreState is worse than one that failed: the failure is visible.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  b3err, b3fail, b3ok, canonicalJson, composeHandle, createObject, deriveClientOpId,
  getObject, isAbsent, listObjects, mintStoreRouteCutoverId, nowIsoUtc,
  type B3Result, type ObjectId, type ScopedStoreHandle,
} from "@novakai/foundation/contract";

import {
  emptyStoreState, legacyStoreOpNames, StoreCore,
} from "../../adapters/store-shared.js";
import type { StoreOp, StoreState } from "../../adapters/store-shared.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import { digestOf, operationKeyOf } from "./store-foundation.js";
import type { MessagingStoreOpPayload } from "./store-foundation.js";
import type { MessagingStoreOpId } from "../contract/records.js";

export interface MessagingCutoverInput {
  /** `.novakai/` root. */
  readonly root: string;
  /** `<root>/stores`. */
  readonly dataRoot: string;
  /** The legacy `store-jsonl` file. Read-only, always. */
  readonly legacyStorePath: string;
}

export interface MessagingCutoverReceipt {
  readonly kind: "storeRouteCutover";
  readonly id: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly permissionLevel: "private";
  readonly createdBy: string;
  readonly dataRoot: string;
  readonly legacyPath: string;
  /** How many source lines were read, converted, and replayed. */
  readonly sourceLineCount: number;
  readonly convertedCount: number;
  /** The two allowed normalisations, counted separately so drift is visible. */
  readonly normalisedInboxItems: number;
  readonly normalisedSingletonJournals: number;
  readonly maxStoreSequence: number;
  /** Only ever `true`: a mismatch blocks the receipt rather than recording it. */
  readonly replayEqual: true;
  readonly traceComplete: boolean;
}

export type MessagingCutoverOutcome =
  | { readonly kind: "completed"; readonly receipt: MessagingCutoverReceipt }
  /** Nothing to do: no legacy file, or a receipt already exists. */
  | { readonly kind: "already-done"; readonly receipt: MessagingCutoverReceipt | null }
  | { readonly kind: "not-required" };

const foundationHandle = (input: MessagingCutoverInput): ScopedStoreHandle => composeHandle({
  root: input.root,
  dataRoot: input.dataRoot,
  capability: "messaging",
  allowedKinds: ["messagingStoreOp", "storeRouteCutover"],
  principal: "sys_messaging",
});

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
  return b3ok(parsed as StoreOp);
}

interface Normalised {
  readonly operation: StoreOp;
  readonly addedInboxItems: boolean;
  readonly wrappedJournal: boolean;
}

/** The two allowed normalisations, and nothing else (§8.1). */
export function normaliseLegacyOp(legacy: StoreOp): Normalised {
  if (legacy.op !== "acceptance") {
    return { operation: legacy, addedInboxItems: false, wrappedJournal: false };
  }
  const asRecord = legacy as unknown as Record<string, unknown>;
  const journal = asRecord["journal"];
  const wrappedJournal = journal !== undefined && !Array.isArray(journal);
  const addedInboxItems = asRecord["agentInboxItems"] === undefined;
  if (!wrappedJournal && !addedInboxItems) {
    return { operation: legacy, addedInboxItems: false, wrappedJournal: false };
  }
  return {
    operation: {
      ...asRecord,
      ...(wrappedJournal ? { journal: [journal] } : {}),
      ...(addedInboxItems ? { agentInboxItems: [] } : {}),
    } as unknown as StoreOp,
    addedInboxItems,
    wrappedJournal,
  };
}

/**
 * Replay both journals and compare the complete resulting state.
 *
 * The comparison is over canonical JSON of every map the store keeps, plus the
 * journal in order. Comparing a summary would pass while losing a Delivery.
 */
function replaysEqual(before: readonly StoreOp[], after: readonly StoreOp[]): boolean {
  return snapshot(before) === snapshot(after);
}

function snapshot(operations: readonly StoreOp[]): string {
  const core = new StoreCore(createSeededClock({ seed: "cutover" }), emptyStoreState());
  for (const operation of operations) core.applyOp(operation);
  const state: StoreState = core.state;
  return canonicalJson({
    threads: [...state.threads.entries()].sort(),
    directThreads: [...state.directThreads.entries()].sort(),
    roomThreads: [...state.roomThreads.entries()].sort(),
    messages: [...state.messages.entries()].sort(),
    snapshots: [...state.snapshots.entries()].sort(),
    deliveries: [...state.deliveries.entries()].sort(),
    attempts: [...state.attempts.entries()].sort(),
    acceptances: [...state.acceptances.entries()].sort(),
    contactPolicies: [...state.contactPolicies.entries()].sort(),
    dndPolicies: [...state.dndPolicies.entries()].sort(),
    templates: [...state.templates.entries()].sort(),
    journal: state.journal,
    lastSequence: state.lastSequence,
  });
}

const receiptIdFor = (dataRoot: string): string =>
  `${mintStoreRouteCutoverId(`messaging:${dataRoot}`)}`;

export async function readMessagingCutoverReceipt(
  input: MessagingCutoverInput,
): Promise<MessagingCutoverReceipt | null> {
  const stored = await getObject<MessagingCutoverReceipt>(
    foundationHandle(input), "storeRouteCutover",
    receiptIdFor(input.dataRoot) as ObjectId,
  );
  if (!stored.ok || isAbsent(stored.value)) return null;
  return stored.value.object;
}

/**
 * §18.1's conflict rule: canonical and legacy both present, with no receipt,
 * blocks boot. Neither file is written.
 *
 * The reason this is a hard block rather than a preference is that Foundation's
 * new-root-first fallback would otherwise silently hide a newer legacy append —
 * two writers, one of them invisible, and no way to tell which is current.
 */
export async function checkMessagingStoreRoute(
  input: MessagingCutoverInput,
): Promise<B3Result<'clear' | 'cutover-required'>> {
  const canonicalPath = `${input.dataRoot}/messagingStoreOps.jsonl`;
  const legacyExists = existsSync(input.legacyStorePath);
  const canonicalExists = existsSync(canonicalPath);
  if (!legacyExists) return b3ok('clear');
  const receipt = await readMessagingCutoverReceipt(input);
  if (receipt !== null) return b3ok('clear');
  if (!canonicalExists) return b3ok('cutover-required');
  return b3fail(b3err("StoreRouteConflict",
    "both the canonical Messaging journal and the legacy store exist with no cutover receipt",
    {
      kind: "messagingStoreOp",
      canonicalPath,
      legacyPath: input.legacyStorePath,
    }, false));
}

interface LegacyJournal {
  readonly lineCount: number;
  readonly source: readonly StoreOp[];
  readonly converted: readonly StoreOp[];
  readonly normalisedInboxItems: number;
  readonly normalisedSingletonJournals: number;
}

/**
 * Parse and normalise the WHOLE file before anything is appended.
 *
 * Two passes rather than one on purpose: a bad line at position 400 must not
 * leave positions 1–399 migrated. The parse pass either produces the complete
 * conversion or it produces a failure, and only then does the append pass run.
 */
function readLegacyJournal(legacyStorePath: string): B3Result<LegacyJournal> {
  const contents = readFileSync(legacyStorePath, "utf8");
  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  const source: StoreOp[] = [];
  const converted: StoreOp[] = [];
  let normalisedInboxItems = 0;
  let normalisedSingletonJournals = 0;

  for (const [index, line] of lines.entries()) {
    const parsed = readLegacyStoreOp(line, index + 1);
    if (!parsed.ok) return parsed;
    source.push(parsed.value);
    const normalised = normaliseLegacyOp(parsed.value);
    if (normalised.addedInboxItems) normalisedInboxItems += 1;
    if (normalised.wrappedJournal) normalisedSingletonJournals += 1;
    converted.push(normalised.operation);
  }
  return b3ok({
    lineCount: lines.length, source, converted,
    normalisedInboxItems, normalisedSingletonJournals,
  });
}

export async function runMessagingCutover(
  input: MessagingCutoverInput,
): Promise<B3Result<MessagingCutoverOutcome>> {
  if (!existsSync(input.legacyStorePath)) return b3ok({ kind: "not-required" });

  const existingReceipt = await readMessagingCutoverReceipt(input);
  if (existingReceipt !== null) {
    return b3ok({ kind: "already-done", receipt: existingReceipt });
  }

  const handle = foundationHandle(input);
  const read = readLegacyJournal(input.legacyStorePath);
  if (!read.ok) return read;
  const {
    lineCount, source, converted, normalisedInboxItems, normalisedSingletonJournals,
  } = read.value;

  // The gate, before anything is appended. A semantic mismatch blocks cutover
  // (§8.1) — the old file stays authoritative and a human finds out.
  if (!replaysEqual(source, converted)) {
    return b3fail(b3err("StoreRouteConflict",
      "converting the legacy Messaging journal changed its replayed state",
      {
        kind: "messagingStoreOp",
        canonicalPath: `${input.dataRoot}/messagingStoreOps.jsonl`,
        legacyPath: input.legacyStorePath,
      }, false));
  }

  let maxStoreSequence = 0;
  for (const [index, operation] of converted.entries()) {
    const storeSequence = index + 1;
    maxStoreSequence = storeSequence;
    const operationKey = operationKeyOf(operation);
    const payload: MessagingStoreOpPayload = {
      kind: "messagingStoreOp",
      id: `messagingStoreOp_migrated${String(storeSequence).padStart(8, "0")}` as
        MessagingStoreOpId,
      schemaVersion: 1,
      createdAt: nowIsoUtc(),
      permissionLevel: "private",
      createdBy: "overridden-by-foundation",
      storeSequence,
      operationKey,
      payloadDigest: digestOf(operation),
      storeOp: operation,
    };
    const written = await createObject(
      handle, payload as unknown as Record<string, unknown> & {
        kind: string; id: string; schemaVersion: number; createdAt: string;
        permissionLevel: "private"; createdBy: string;
      },
      deriveClientOpId(`messagingCutover:${operationKey}:${String(storeSequence)}`),
    );
    if (!written.ok) {
      return b3fail(b3err("StoreUnavailable",
        `migrating legacy line ${String(storeSequence)} failed: ${written.error.code}`,
        { owner: "messaging", cause: written.error.code }, true));
    }
  }

  const receipt: MessagingCutoverReceipt = {
    kind: "storeRouteCutover",
    id: receiptIdFor(input.dataRoot),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: "private",
    createdBy: "overridden-by-foundation",
    dataRoot: input.dataRoot,
    legacyPath: input.legacyStorePath,
    sourceLineCount: lineCount,
    convertedCount: converted.length,
    normalisedInboxItems,
    normalisedSingletonJournals,
    maxStoreSequence,
    replayEqual: true,
    traceComplete: false,
  };
  const wroteReceipt = await createObject(
    handle, receipt as unknown as Record<string, unknown> & {
      kind: string; id: string; schemaVersion: number; createdAt: string;
      permissionLevel: "private"; createdBy: string;
    },
    deriveClientOpId(`messagingCutoverReceipt:${input.dataRoot}`),
  );
  if (!wroteReceipt.ok) {
    return b3fail(b3err("StoreUnavailable",
      `the cutover receipt could not be written: ${wroteReceipt.error.code}`,
      { owner: "messaging", cause: wroteReceipt.error.code }, true));
  }

  // Trace-complete is RECONCILED, not asserted: the receipt claims it only
  // after its own trace is readable back through Foundation. Dispatch waits on
  // this, so a receipt that says `traceComplete: true` on faith would let the
  // canonical route open over an unproven migration.
  const reconciled = await traceComplete(handle, receipt.id);
  const sealed: MessagingCutoverReceipt = { ...receipt, traceComplete: reconciled };
  return b3ok({ kind: "completed", receipt: sealed });
}

async function traceComplete(handle: ScopedStoreHandle, receiptId: string): Promise<boolean> {
  const stored = await getObject<MessagingCutoverReceipt>(
    handle, "storeRouteCutover", receiptId as ObjectId,
  );
  if (!stored.ok || isAbsent(stored.value)) return false;
  return stored.value.lastMutation.serverOpId !== undefined;
}

/** Every migrated operation, for a verification command to count (§17.1 doctor). */
export async function listMigratedOperations(
  input: MessagingCutoverInput,
): Promise<B3Result<readonly MessagingStoreOpPayload[]>> {
  const page = await listObjects<MessagingStoreOpPayload>(
    foundationHandle(input), "messagingStoreOp", undefined, { limit: 1_000_000 },
  );
  if (!page.ok) {
    return b3fail(b3err("StoreUnavailable", `reading the migrated journal failed: ${page.error.code}`,
      { owner: "messaging", cause: page.error.code }, true));
  }
  return b3ok(page.value.items.map((item) => item.object));
}
