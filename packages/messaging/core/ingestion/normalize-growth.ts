import type {
  NormalizedProviderLine,
  ProviderNormalizer,
  ProviderLineExtent,
  ProviderSourceGrowth,
} from '../../contract/ports/provider-transcript-source.js';
import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';

/** One normalized provider record paired with its durable byte extent. */
export interface NormalizedExtent {
  readonly extent: ProviderLineExtent;
  readonly value: NormalizedProviderLine;
}

/** Complete records and checkpoint facts parsed from one source growth read. */
export interface NormalizedGrowth {
  readonly committedBytes: Uint8Array;
  readonly items: readonly NormalizedExtent[];
  readonly baseTurnIndex: number;
  readonly complete: boolean;
}

function completeExtents(bytes: Uint8Array, fromOffset: number): {
  readonly extents: readonly ProviderLineExtent[];
  readonly committedBytes: Uint8Array;
} {
  const buffer = Buffer.from(bytes);
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return { extents: [], committedBytes: Buffer.alloc(0) };
  const committedBytes = buffer.subarray(0, lastNewline + 1);
  const extents: ProviderLineExtent[] = [];
  let start = 0;
  while (start < committedBytes.length) {
    const newline = committedBytes.indexOf(0x0a, start);
    if (newline < 0) break;
    const lineEnd = committedBytes[newline - 1] === 0x0d ? newline - 1 : newline;
    extents.push({
      raw: committedBytes.subarray(start, lineEnd).toString('utf8'),
      offset: fromOffset + start,
      nextOffset: fromOffset + newline + 1,
    });
    start = newline + 1;
  }
  return { extents, committedBytes };
}

/** Parses only complete JSONL extents and retains an incomplete tail for retry. */
export function normalizeGrowth(
  normalizer: ProviderNormalizer,
  growth: ProviderSourceGrowth,
  checkpoint: IngestCheckpoint | null,
): NormalizedGrowth {
  const parsed = completeExtents(growth.bytes, growth.fromOffset);
  const baseTurnIndex = checkpoint?.sourceEpoch === growth.sourceEpoch
    ? checkpoint.nextTurnIndex
    : 0;
  return {
    committedBytes: parsed.committedBytes,
    complete: parsed.committedBytes.byteLength === growth.bytes.byteLength,
    baseTurnIndex,
    items: parsed.extents.map((extent, index) => ({
      extent,
      value: normalizer.normalize(extent, baseTurnIndex + index),
    })),
  };
}
