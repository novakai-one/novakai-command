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
  b3err, b3fail, b3ok, bootstrapStoreRouteCutover, canonicalJson, composeHandle,
  deriveClientOpId, getObject, isAbsent, listObjects, mintMessagingStoreOpId,
  mintStoreRouteCutoverId, nowIsoUtc,
  type B3Result, type ObjectId, type ScopedStoreHandle,
} from "@novakai/foundation/contract";

import {
  emptyStoreState, StoreCore,
} from "../../adapters/store-shared.js";
import type { StoreOp, StoreState } from "../../adapters/store-shared.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import { readLegacyStoreOp } from "./cutover-validate.js";
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
  /**
   * §18.1 step 4's byte-copyable half — the B1 Foundation files sitting flat in
   * `.novakai/`, and the kinds among them the canonical route does not have yet.
   *
   * It rides in the SAME cutover because §18.1 gives the two halves one fence
   * and one receipt: "before allowing the shared trace-complete cutover receipt
   * to commit". Two receipts would mean two moments at which dispatch could
   * open, and the second half would open over the first half's unproven state.
   */
  readonly copy?: {
    readonly legacyRoot: string;
    readonly kinds: readonly string[];
  };
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
  /**
   * §18.1 step 4's byte-copied kinds, named on the receipt.
   *
   * A receipt that recorded only the converted Messaging journal would say the
   * route moved while being silent about the forty files that moved with it —
   * and this receipt is the only durable record of which files a given root's
   * canonical route inherited rather than wrote.
   */
  readonly copiedKinds: readonly string[];
}

export type MessagingCutoverOutcome =
  | { readonly kind: "completed"; readonly receipt: MessagingCutoverReceipt }
  /** Nothing to do: no legacy file, or a receipt already exists. */
  | { readonly kind: "already-done"; readonly receipt: MessagingCutoverReceipt | null }
  | { readonly kind: "not-required" };

/**
 * Messaging's own READ handle.
 *
 * `storeRouteCutover` is deliberately absent. It shipped in this list, and
 * `packages/foundation/tests/b3a-registry.test.ts` proves the same handle is
 * refused that kind — the cutover was granting itself the one thing §18.1
 * marks Foundation-bootstrap-only, which would let a capability seal its own
 * migration and open the canonical route on its own say-so.
 *
 * The receipt is now written by `bootstrapStoreRouteCutover`, which is a
 * Foundation function rather than a handle anyone can hold. This handle only
 * READS it back.
 */
const foundationHandle = (input: MessagingCutoverInput): ScopedStoreHandle => composeHandle({
  root: input.root,
  dataRoot: input.dataRoot,
  capability: "messaging",
  allowedKinds: ["messagingStoreOp"],
  principal: "sys_messaging",
});

// The legacy-line validator lives in `cutover-validate.ts` — parsing is not
// migrating, and it is the half of this file that needs no root on disk.


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
  const converting = existsSync(input.legacyStorePath);
  const copying = (input.copy?.kinds.length ?? 0) > 0;
  // Nothing to convert AND nothing to copy is the only "not required". It used
  // to be "no legacy Messaging journal", which meant a B1 root with forty
  // Foundation files and no custom Messaging journal migrated nothing at all
  // and sealed no receipt.
  if (!converting && !copying) return b3ok({ kind: "not-required" });

  const existingReceipt = await readMessagingCutoverReceipt(input);
  if (existingReceipt !== null) {
    return b3ok({ kind: "already-done", receipt: existingReceipt });
  }

  const read = converting
    ? readLegacyJournal(input.legacyStorePath)
    : b3ok<LegacyJournal>({
      lineCount: 0, source: [], converted: [],
      normalisedInboxItems: 0, normalisedSingletonJournals: 0,
    });
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

  // Every converted operation, prepared BEFORE the bootstrap takes the lock.
  // Ids are the same deterministic base32 digest the live adapter mints
  // (`mintMessagingStoreOpId(operationKey)`), which is what makes a post-cutover
  // retry of a migrated operation land on its own record. The shipped
  // `messagingStoreOp_migratedNNNNNNNN` ids matched no live key, so the first
  // replay of any migrated operation would have appended a twin.
  let maxStoreSequence = 0;
  const records = converted.map((operation, index) => {
    const storeSequence = index + 1;
    maxStoreSequence = storeSequence;
    const operationKey = operationKeyOf(operation);
    const payload: MessagingStoreOpPayload = {
      kind: "messagingStoreOp",
      id: mintMessagingStoreOpId(operationKey) as string as MessagingStoreOpId,
      schemaVersion: 1,
      createdAt: nowIsoUtc(),
      permissionLevel: "private",
      // Foundation's bootstrap derives the real value from its own principal.
      createdBy: "overridden-by-foundation",
      storeSequence,
      operationKey,
      payloadDigest: digestOf(operation),
      storeOp: operation,
    };
    return {
      kind: "messagingStoreOp",
      payload,
      clientOpId: deriveClientOpId(`messagingStoreOp:${operationKey}`),
    };
  });

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
    // Set by the bootstrap after it reads its own trace back, and PERSISTED.
    traceComplete: false,
    copiedKinds: [...(input.copy?.kinds ?? [])],
  };

  // One lock-held bootstrap, through Foundation — not a per-line createObject
  // loop through a handle that granted itself the receipt kind. §18.1's fsync
  // choreography and the durable trace-complete seal live in there, because
  // that is where the lock and the engine primitives are.
  const bootstrapped = await bootstrapStoreRouteCutover({
    root: input.root,
    dataRoot: input.dataRoot,
    ...(input.copy === undefined ? {} : { copy: input.copy }),
    records,
    receipt: {
      kind: "storeRouteCutover",
      payload: receipt,
      clientOpId: deriveClientOpId(`messagingCutoverReceipt:${input.dataRoot}`),
    },
  });
  if (!bootstrapped.ok) {
    return b3fail(b3err("StoreUnavailable",
      `the Messaging cutover bootstrap failed: ${bootstrapped.error.code} `
      + bootstrapped.error.message,
      { owner: "messaging", cause: bootstrapped.error.code }, true));
  }
  if (!bootstrapped.value.traceComplete) {
    // §18.1 step 7: dispatch stays blocked until the receipt reconciles
    // trace-complete. Returning `completed` here would open the canonical route
    // over a migration whose own trace could not be read back.
    return b3fail(b3err("StoreRouteConflict",
      "the cutover receipt did not reconcile trace-complete; the canonical route stays closed",
      {
        kind: "messagingStoreOp",
        canonicalPath: `${input.dataRoot}/messagingStoreOps.jsonl`,
        legacyPath: input.legacyStorePath,
      }, false));
  }
  return b3ok({ kind: "completed", receipt: { ...receipt, traceComplete: true } });
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
