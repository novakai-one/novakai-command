import type {
  TranscriptRelationState,
  TranscriptSource,
  TranscriptSourceItem,
} from './schemas.js';

/**
 * Internal variation seam published for composition. The Transcript core owns
 * checkpoint selection and advancement; adapters only enumerate sources and
 * yield normalized candidates or typed skips from the requested byte offset.
 *
 * Discovery is a single sequential pass. Each yielded source is an ephemeral
 * handle: consume it before requesting the next source. The handle expires
 * when its read finishes or closes, discovery advances, or discovery closes.
 */
export interface TranscriptSourceAdapter {
  sources(): AsyncIterable<TranscriptSource>;
  read(
    source: TranscriptSource,
    fromOffset: number,
    relationState?: TranscriptRelationState,
  ): AsyncIterable<TranscriptSourceItem>;
}
