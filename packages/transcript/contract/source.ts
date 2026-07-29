import type {
  TranscriptSource,
  TranscriptSourceItem,
} from './schemas.js';

/**
 * Internal variation seam published for composition. The Transcript core owns
 * checkpoint selection and advancement; adapters only enumerate sources and
 * yield normalized candidates or typed skips from the requested byte offset.
 */
export interface TranscriptSourceAdapter {
  sources(): AsyncIterable<TranscriptSource>;
  read(
    source: TranscriptSource,
    fromOffset: number,
  ): AsyncIterable<TranscriptSourceItem>;
}
