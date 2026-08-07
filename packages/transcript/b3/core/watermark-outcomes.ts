/**
 * §13.9's precondition for advancing the mirror watermark.
 *
 * "The mirror watermark advances only after a durable filtered outcome or
 * durable Message/effect result." `PromoteMirrorWatermarkInput.outcomeRefs` is
 * that sentence as an argument — the outcomes the caller says justify the
 * advance — and nothing read it. So an explicit promotion could push a healthy
 * binding's watermark to any string, and every source position it skipped would
 * never be read again: turns lost silently, with nothing afterwards saying a
 * gap exists.
 *
 * It lives beside the mirror rather than inside `compose.ts` because it is the
 * mirror's rule, not the composition's.
 */

import { b3err, b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';

import type { PromoteMirrorWatermarkInput } from '../contract/api.js';
import type { TranscriptBindingId } from '../contract/records.js';
import type { MirrorLedgerEntry } from './mirror.js';
import type { TranscriptStore } from './store.js';

const invalid = (message: string, path: string): B3Result<never> =>
  b3fail(b3err('ValidationFailed', message, { issues: [{ path, message }] }, false));

/**
 * Every ref must resolve to a mirror ledger entry — the record the ingest
 * writes for one source position, carrying `mirrored` or `filtered` — and it
 * must belong to THIS binding. One of them must cover `nextWatermark` itself,
 * which is the whole point: the watermark may only come to rest on a position
 * whose outcome is on disk.
 *
 * A ref belonging to another binding is refused rather than ignored. Ignoring
 * it would let a caller pad a legitimate list with someone else's outcomes and
 * learn nothing about why it worked.
 */
export async function requireDurableOutcomes(
  store: TranscriptStore,
  bindingId: TranscriptBindingId,
  input: PromoteMirrorWatermarkInput,
): Promise<B3Result<null>> {
  if (input.outcomeRefs.length === 0) {
    return invalid(
      'a watermark advance must name the durable outcomes that justify it (§13.9)',
      'outcomeRefs',
    );
  }
  let coversTarget = false;
  for (const claimed of input.outcomeRefs) {
    const entry = await ownedEntry(store, bindingId, claimed);
    if (!entry.ok) return entry;
    if (entry.value.sourcePosition === input.nextWatermark) coversTarget = true;
  }
  if (!coversTarget) {
    return invalid(`no named outcome covers position ${input.nextWatermark}`, 'nextWatermark');
  }
  return b3ok(null);
}

/**
 * One named outcome, resolved and attributed. A ref belonging to another
 * binding is refused rather than ignored: ignoring it would let a caller pad a
 * legitimate list with someone else's outcomes and learn nothing about why it
 * worked.
 */
async function ownedEntry(
  store: TranscriptStore, bindingId: TranscriptBindingId, ledgerId: string,
): Promise<B3Result<MirrorLedgerEntry>> {
  const found = await store.read<MirrorLedgerEntry>('transcriptLine', ledgerId as never);
  if (!found.ok) return found;
  if (found.value === null) return invalid(`outcome ${ledgerId} does not exist`, 'outcomeRefs');
  if (found.value.bindingId !== bindingId) {
    return invalid(`outcome ${ledgerId} belongs to another binding`, 'outcomeRefs');
  }
  return b3ok(found.value);
}
