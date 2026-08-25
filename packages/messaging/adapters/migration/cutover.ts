import { existsSync, readFileSync } from "node:fs";
import {
  b3err, b3fail, b3ok, bootstrapStoreRouteCutover, canonicalJson, composeHandle,
  deriveClientOpId, getObject, isAbsent, listObjects, mintMessagingStoreOpId,
  mintStoreRouteCutoverId, nowIsoUtc,
  type B3Result, type ObjectId, type ScopedStoreHandle,
} from "@novakai/foundation/contract";

import { emptyStoreState, StoreCore } from "../store-shared.js";
import type { StoreOp, StoreState } from "../store-shared.js";
import { readLegacyStoreOp } from "./cutover-validate.js";
import { digestOf, operationKeyOf } from "../store-operation-identity.js";
import type { MessagingStoreOpPayload } from "../stores/foundation-v1.js";
import type { MessagingStoreOpId } from "../../contract/records/legacy-agent-mail.js";
import type { IdKind, IdTypeMap, Timestamp } from "../../contract/schemas.js";
import type { ClockIds } from "../../contract/ports/clock.js";

const REPLAY_CLOCK: ClockIds = {
  now: () => '2026-01-01T00:00:00.000Z' as Timestamp,
  newId<Kind extends IdKind>(_kind: Kind): IdTypeMap[Kind] {
    throw new Error('Cutover replay must not mint new Messaging identities');
  },
};
/** Physical roots and optional Foundation kinds participating in cutover. */
export interface MessagingCutoverInput {
  readonly root: string;
  readonly dataRoot: string;
  readonly legacyStorePath: string;
  readonly copy?: {
    readonly legacyRoot: string;
    readonly kinds: readonly string[];
  };
}
/** Durable proof that the canonical journal reproduces the legacy state. */
export interface MessagingCutoverReceipt {
  readonly kind: "storeRouteCutover";
  readonly id: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly permissionLevel: "private";
  readonly createdBy: string;
  readonly dataRoot: string;
  readonly legacyPath: string;
  readonly sourceLineCount: number;
  readonly convertedCount: number;
  readonly normalisedInboxItems: number;
  readonly normalisedSingletonJournals: number;
  readonly maxStoreSequence: number;
  readonly replayEqual: true;
  readonly traceComplete: boolean;
  readonly copiedKinds: readonly string[];
}
/** Idempotent result of attempting the one-time Messaging store migration. */
export type MessagingCutoverOutcome =
  | { readonly kind: "completed"; readonly receipt: MessagingCutoverReceipt }
  /** Nothing to do: no legacy file, or a receipt already exists. */
  | { readonly kind: "already-done"; readonly receipt: MessagingCutoverReceipt | null }
  | { readonly kind: "not-required" };
/** Messaging can read the cutover receipt; only Foundation bootstrap writes it. */
const foundationHandle = (input: MessagingCutoverInput): ScopedStoreHandle => composeHandle({
  root: input.root,
  dataRoot: input.dataRoot,
  capability: "messaging",
  allowedKinds: ["messagingStoreOp"],
  principal: "sys_messaging",
});
interface Normalised {
  readonly operation: StoreOp;
  readonly addedInboxItems: boolean;
  readonly wrappedJournal: boolean;
}
function normaliseLegacyOp(legacy: StoreOp): Normalised {
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
function replaysEqual(before: readonly StoreOp[], after: readonly StoreOp[]): boolean {
  return snapshot(before) === snapshot(after);
}
function snapshot(operations: readonly StoreOp[]): string {
  const core = new StoreCore(REPLAY_CLOCK, emptyStoreState());
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
/** Read the Foundation-owned cutover receipt, when one exists. */
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
/** Refuse two possible authorities unless a receipt proves the cutover. */
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
/** Parse the whole file before appending anything. */
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

/** Migrate the legacy journal only after replay equality has been proved. */
export async function runMessagingCutover(
  input: MessagingCutoverInput,
): Promise<B3Result<MessagingCutoverOutcome>> {
  const converting = existsSync(input.legacyStorePath);
  const copying = (input.copy?.kinds.length ?? 0) > 0;
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
    traceComplete: false,
    copiedKinds: [...(input.copy?.kinds ?? [])],
  };

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

/** List canonical v1 operations for the read-only cutover report. */
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
