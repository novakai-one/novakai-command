/**
 * The mirror's ledger — what happened at one source position.
 *
 * Split out of `mirror.ts` because recording an outcome is not deciding one.
 * The pipeline decides; this is the durable sentence it writes down, and it is
 * the sentence a replay reads to recognise what it already did (§8.2, §13.9).
 */

import {
  deriveClientOpId, nowIsoUtc,
  type B3Result, type ClientOpId, type RecordEnvelope,
} from '@novakai/foundation/contract';
import { createHash } from 'node:crypto';

import type { TranscriptLineId } from '../contract/records.js';
import type { TranscriptStore } from './store.js';

/**
 * One position's recorded outcome, so a replay recognises what it already did.
 *
 * It rides the existing `transcriptLine` kind rather than adding a sixth:
 * "what happened at this source position" is exactly what a transcript line
 * IS, and §18.1's inventory does not grow for a fact the registry already has
 * a home for.
 */
export interface MirrorLedgerEntry
  extends RecordEnvelope<TranscriptLineId, 'transcriptLine'> {
  readonly bindingId: string;
  readonly sourcePosition: string;
  readonly sourceDigest: string;
  readonly outcome: 'mirrored' | 'filtered';
  /**
   * Whose turn this was. `classifyTurn` decides it and Messaging gets it; the
   * durable line dropped it, so §25-B3c's projection was readable from the
   * Messages and not from the transcript. Absent on a filtered line — "no
   * conversation role" is exactly why it was filtered.
   */
  readonly role?: 'human' | 'assistant';
  /**
   * What was said. `role` alone told a reader whose turn it was but never
   * WHICH turn, so `transcriptLines.jsonl` — the file §18.1 registers as the
   * transcript — could not answer "was the turn I just typed mirrored?"
   * without already holding the messageId the transcript is what gives you.
   * The sealed B2b `transcriptLine` schema and §8.2's `NormalisedTranscriptTurn`
   * carry role AND text; this line is the same kind and now says both.
   *
   * Absent on a filtered line, exactly as `role` is: noise is not conversation,
   * and §8.2 keeps tool chatter out of the turns a reader asks about.
   */
  readonly text?: string;
  readonly filterReason?: string;
  readonly messageId?: string;
}

/**
 * The ledger id for one (binding, position). Deterministic, so a replay of the
 * same position finds its own entry rather than writing a second one.
 */
export const mirrorLedgerId = (bindingId: string, position: string): TranscriptLineId =>
  `transcriptLine_${createHash('sha256')
    .update(`b3v4${bindingId}${position}`, 'utf8')
    .digest('hex')}` as TranscriptLineId;


/** One durable outcome, exactly as the pipeline decided it. */
export interface LedgerWrite {
  readonly id: TranscriptLineId;
  readonly bindingId: string;
  readonly position: string;
  readonly digest: string;
  readonly outcome: 'mirrored' | 'filtered';
  readonly role?: 'human' | 'assistant';
  readonly text?: string;
  readonly filterReason?: string;
  readonly messageId?: string;
}

export async function recordLedger(
  store: TranscriptStore, entry: LedgerWrite,
): Promise<B3Result<unknown>> {
  return store.create({
    kind: 'transcriptLine',
    id: entry.id,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: 'sys_transcript',
    bindingId: entry.bindingId,
    sourcePosition: entry.position,
    sourceDigest: entry.digest,
    outcome: entry.outcome,
    ...(entry.role === undefined ? {} : { role: entry.role }),
    ...(entry.text === undefined ? {} : { text: entry.text }),
    ...(entry.filterReason === undefined ? {} : { filterReason: entry.filterReason }),
    ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
  } as never, keyFor(`ledger:${entry.id}`));
}

const keyFor = (effect: string): ClientOpId => deriveClientOpId(`transcript:${effect}`);
