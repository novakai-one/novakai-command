// `nvk runtime doctor --cutover` — the verification command (§17.1, surface #10).
//
// A cutover that only says "done" is not verifiable. This reports what
// actually happened, per kind: whether each canonical file exists beside its
// legacy source, how many Messaging operations of each variant were migrated,
// which of the two allowed normalisations were applied and how often, whether
// replay equality held, and whether the receipt reconciled trace-complete.
//
// It is a READ. It never migrates, never writes, and never touches the legacy
// files — the whole point is to be safe to run when you are worried.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { b3ok, type B3Result } from '@novakai/foundation/contract';
import {
  listMigratedOperations, readMessagingCutoverReceipt,
} from '../../../messaging/b3/contract/index.js';

/**
 * The legacy Messaging journal, as the product actually writes it
 * (`packages/server/core/boot.ts:146` opens `<root>/messaging.jsonl`).
 *
 * A constant because it was a literal in two places and they disagreed: the
 * doctor looked for `messaging-store.jsonl`, which nothing has ever written, so
 * a root with a real legacy journal beside it reported `clear`. One name, one
 * place, and boot and the doctor now cannot drift apart.
 */
export const LEGACY_MESSAGING_STORE = 'messaging.jsonl';

export interface CutoverKindReport {
  readonly kind: string;
  readonly canonicalPath: string;
  readonly canonicalExists: boolean;
  readonly legacyPath: string;
  readonly legacyExists: boolean;
  /** Bytes, so "the copy is empty" is visible rather than inferred. */
  readonly canonicalBytes: number;
  readonly legacyBytes: number;
}

export interface CutoverReport {
  readonly schemaVersion: 1;
  readonly dataRoot: string;
  readonly perKind: readonly CutoverKindReport[];
  /**
   * Operations in the CANONICAL journal, by StoreOp variant.
   *
   * Not "migrated" operations: after a cutover the canonical journal holds
   * both the migrated ones and everything written since, and there is no
   * honest way to tell them apart from the outside. Calling the total
   * "migrated" would overstate what a cutover did on a store that was never
   * migrated at all.
   */
  readonly messagingVariantCounts: Readonly<Record<string, number>>;
  readonly normalisations: {
    readonly addedInboxItems: number;
    readonly wrappedSingletonJournals: number;
  };
  readonly replayEqual: boolean | null;
  readonly receipt: {
    readonly present: boolean;
    readonly traceComplete: boolean;
    readonly sourceLineCount: number | null;
    readonly maxStoreSequence: number | null;
  };
  /**
   * What a reader should conclude. Deliberately three-valued: `blocked` is not
   * a failure of this command, it is the honest state of a route that has a
   * legacy file and no receipt.
   */
  readonly verdict: 'clear' | 'cutover-required' | 'blocked';
}

export interface CutoverReportInput {
  readonly root: string;
  readonly dataRoot: string;
  /** kind → the legacy file that kind used to live in. */
  readonly legacySources: Readonly<Record<string, string>>;
}

export async function buildCutoverReport(
  input: CutoverReportInput,
): Promise<B3Result<CutoverReport>> {
  const perKind: CutoverKindReport[] = [];
  for (const [kind, legacyPath] of Object.entries(input.legacySources)) {
    const canonicalPath = path.join(input.dataRoot, `${kind}s.jsonl`);
    perKind.push({
      kind,
      canonicalPath,
      canonicalExists: existsSync(canonicalPath),
      legacyPath,
      legacyExists: existsSync(legacyPath),
      canonicalBytes: sizeOf(canonicalPath),
      legacyBytes: sizeOf(legacyPath),
    });
  }

  const messagingLegacy = input.legacySources['messagingStoreOp'] ?? '';
  const cutoverInput = {
    root: input.root, dataRoot: input.dataRoot, legacyStorePath: messagingLegacy,
  };
  const receipt = messagingLegacy === ''
    ? null
    : await readMessagingCutoverReceipt(cutoverInput);

  const variantCounts: Record<string, number> = {};
  const migrated = await listMigratedOperations(cutoverInput);
  if (migrated.ok) {
    for (const record of migrated.value) {
      const variant = record.storeOp.op;
      variantCounts[variant] = (variantCounts[variant] ?? 0) + 1;
    }
  }

  const messagingRow = perKind.find((entry) => entry.kind === 'messagingStoreOp');
  const verdict = decide(messagingRow, receipt !== null);

  return b3ok({
    schemaVersion: 1,
    dataRoot: input.dataRoot,
    perKind,
    messagingVariantCounts: variantCounts,
    normalisations: {
      addedInboxItems: receipt?.normalisedInboxItems ?? 0,
      wrappedSingletonJournals: receipt?.normalisedSingletonJournals ?? 0,
    },
    replayEqual: receipt === null ? null : receipt.replayEqual,
    receipt: {
      present: receipt !== null,
      traceComplete: receipt?.traceComplete ?? false,
      sourceLineCount: receipt?.sourceLineCount ?? null,
      maxStoreSequence: receipt?.maxStoreSequence ?? null,
    },
    verdict,
  });
}

/**
 * §18.1's conflict rule, restated as a verdict rather than an exception: both
 * files present with no receipt is `blocked`, and boot stays blocked until
 * somebody runs the cutover or removes the legacy file deliberately.
 */
function decide(
  messaging: CutoverKindReport | undefined, hasReceipt: boolean,
): CutoverReport['verdict'] {
  if (messaging === undefined || !messaging.legacyExists) return 'clear';
  if (hasReceipt) return 'clear';
  return messaging.canonicalExists ? 'blocked' : 'cutover-required';
}

const sizeOf = (filePath: string): number =>
  (existsSync(filePath) ? statSync(filePath).size : 0);

export function describeCutover(report: CutoverReport): string {
  const rows = report.perKind.map((entry) =>
    `  ${entry.kind}: canonical `
    + `${entry.canonicalExists ? `${String(entry.canonicalBytes)}B` : 'absent'}`
    + ` · legacy ${entry.legacyExists ? `${String(entry.legacyBytes)}B` : 'absent'}`).join('\n');
  const variants = Object.entries(report.messagingVariantCounts)
    .map(([variant, count]) => `${variant}=${String(count)}`).join(' ');
  const verdict = {
    clear: 'Nothing is blocked; the canonical route is authoritative.',
    'cutover-required': 'A legacy Messaging store exists and has not been migrated yet.',
    blocked: 'Both a canonical and a legacy Messaging store exist with no cutover receipt.'
      + ' Boot stays blocked until one of them is dealt with.',
  }[report.verdict];
  return `Store route under ${report.dataRoot}\n${rows}\n`
    + `  canonical journal: ${variants === '' ? 'empty' : variants}\n`
    + `  normalisations: +agentInboxItems ${String(report.normalisations.addedInboxItems)}`
    + ` · journal[] ${String(report.normalisations.wrappedSingletonJournals)}\n`
    + `  replay equal: ${report.replayEqual === null ? 'not run' : String(report.replayEqual)}\n`
    + `  receipt: ${report.receipt.present ? 'present' : 'absent'}`
    + ` · trace-complete ${String(report.receipt.traceComplete)}\n${verdict}`;
}
