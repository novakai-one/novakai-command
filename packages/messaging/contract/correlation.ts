import { createHash } from 'node:crypto';

/** Stable provider-neutral hint shared by send attempts and user transcript lines. */
export function messageCorrelationHint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
