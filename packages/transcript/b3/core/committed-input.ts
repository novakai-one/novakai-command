/**
 * What a committed HUMAN turn tells the world about itself — B3d.
 *
 * Something outside Transcript may have CAUSED a turn: an input typed into the
 * Agent's terminal on behalf of a Notification, a watcher, a person. None of
 * those can read a provider transcript, and Transcript must not learn what any
 * of them are. So a committed human turn announces the facts that identify it —
 * which line, which position, which digests — and whoever caused it recognises
 * its own input by them.
 *
 * An assistant turn is nobody's input and carries none of this.
 */
import { createHash } from 'node:crypto';

import type { CommittedInputLine, SourceLine } from '../contract/api.js';
import type { TranscriptLineId } from '../contract/records.js';

export function committedInputOf(
  role: 'human' | 'assistant',
  line: SourceLine,
  transcriptLineId: TranscriptLineId,
  text: string,
): { readonly committedInput?: CommittedInputLine } {
  if (role !== 'human') return {};
  return {
    committedInput: {
      transcriptLineId,
      sourcePosition: line.position,
      sourceDigest: line.digest,
      // Over the CLASSIFIED text — what a person would have read, control
      // sequences already stripped. A digest over the raw row would never match
      // the input anybody believes they sent.
      textDigest: createHash('sha256').update(text, 'utf8').digest('hex'),
    },
  };
}
