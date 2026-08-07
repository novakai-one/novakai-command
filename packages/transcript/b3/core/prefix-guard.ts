/**
 * The committed-prefix guard — spec ruling Q9, §8.2, §13.9.
 *
 * §8.2 says a different digest at the same source position is corruption, and
 * says it without a temporal or watermark qualification. Forward resumption
 * that re-reads only the watermark line therefore enforces the rule for
 * exactly one position, and a provider file rewritten anywhere BELOW it is
 * invisible: the mirror carries on, the watermark advances over a conflict
 * nobody has looked at, and turns whose provenance is already known to be
 * wrong commit as Messages.
 *
 * Q9 ruled that the safest reading is binding for the B3c seal: historical
 * mutation is inside the quarantine contract and must be detected BEFORE the
 * mirror commits any later outcome or advances the watermark. This module is
 * that detector, and it is deliberately COMPLETE rather than clever — every
 * committed position is compared on every advancement, because a checkpoint
 * scheme is only permitted where detection coverage survives it.
 *
 * It decides nothing. It answers one question — "is the committed prefix still
 * what we committed?" — and the pipeline owns what to do about the answer.
 */

import type { B3Result } from '@novakai/foundation/contract';

import type { SourcePositionDigest, TranscriptSourcePort } from '../contract/api.js';
import type { TranscriptBinding } from '../contract/records.js';
import { mirrorLedgerId, type MirrorLedgerEntry } from './ledger.js';
import type { TranscriptStore } from './store.js';

export type PrefixVerdict =
  /** Every committed position still holds the bytes it was committed from. */
  | { readonly kind: 'intact' }
  /** The source no longer answers. Nothing was proved either way. */
  | { readonly kind: 'unreadable'; readonly reason: string }
  /** §8.2 corruption, at the FIRST position that disagrees. */
  | { readonly kind: 'conflict'; readonly position: string; readonly ledgerId: string }
  | { readonly kind: 'failed'; readonly error: B3Result<never> };

export interface PrefixGuardDeps {
  readonly store: TranscriptStore;
  readonly source: TranscriptSourcePort;
}

/**
 * Compare the source's current prefix against the durable ledger, through
 * `throughPosition` inclusive.
 *
 * Three things count as a conflict, because all three mean the committed
 * prefix is no longer the prefix that was committed:
 *
 *   - a position whose digest changed (the rewrite §8.2 names);
 *   - a position the source now has and the ledger never recorded — a line
 *     INSERTED below the watermark, which shifts everything after it;
 *   - a position the ledger recorded and the source no longer has — a deletion
 *     or truncation under committed turns.
 *
 * The first two are reported at the source position; the third at the ledger's.
 * Whichever comes first in position order is the one returned, so the
 * quarantine names the earliest place the two stories diverge.
 */
export async function verifyCommittedPrefix(
  deps: PrefixGuardDeps, binding: TranscriptBinding, throughPosition: string,
): Promise<PrefixVerdict> {
  const prefix = await deps.source.readPrefixDigests(binding, throughPosition);
  if (prefix.kind === 'missing') {
    return { kind: 'unreadable', reason: 'the source is no longer present' };
  }
  if (prefix.kind === 'unavailable') return { kind: 'unreadable', reason: prefix.reason };

  const recorded = await deps.store.list<MirrorLedgerEntry>(
    'transcriptLine', { bindingId: binding.id },
  );
  if (!recorded.ok) return { kind: 'failed', error: recorded };

  const ledger = new Map<string, MirrorLedgerEntry>();
  for (const entry of recorded.value) {
    if (entry.sourcePosition > throughPosition) continue;
    ledger.set(entry.sourcePosition, entry);
  }
  return compare(binding, throughPosition, prefix.digests, ledger);
}

/**
 * The two stories, walked side by side. Consumes `ledger` as it goes, so what
 * is left at the end is exactly the set of positions the source has stopped
 * holding.
 */
function compare(
  binding: TranscriptBinding, throughPosition: string,
  digests: readonly SourcePositionDigest[], ledger: Map<string, MirrorLedgerEntry>,
): PrefixVerdict {
  for (const { position, digest } of digests) {
    const entry = ledger.get(position);
    if (entry === undefined) {
      // A position the mirror has not reached yet is not a conflict: the prefix
      // read is inclusive of the watermark, and the watermark line's own ledger
      // is written by the pass that is about to run.
      if (position >= throughPosition) continue;
      return { kind: 'conflict', position, ledgerId: mirrorLedgerId(binding.id, position) };
    }
    ledger.delete(position);
    if (entry.sourceDigest !== digest) {
      return { kind: 'conflict', position, ledgerId: entry.id };
    }
  }
  return orphaned([...ledger.values()]);
}

/** A position the ledger recorded and the source no longer has. */
function orphaned(entries: readonly MirrorLedgerEntry[]): PrefixVerdict {
  const first = [...entries]
    .sort((left, right) => (left.sourcePosition < right.sourcePosition ? -1 : 1))[0];
  if (first === undefined) return { kind: 'intact' };
  return { kind: 'conflict', position: first.sourcePosition, ledgerId: first.id };
}
