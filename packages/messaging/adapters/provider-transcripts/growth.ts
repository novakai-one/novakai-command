import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type {
  ProviderSourceGrowth,
  ProviderSourceStat,
} from '../../contract/ports/provider-transcript-source.js';
import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';

const VERIFY_BYTES = 64;
// Unscoped files exist machine-wide and may be hundreds of megabytes. They
// still need a bounded chance to reveal an app-owned marker, but one file must
// never monopolise the server loop. Explicit adoption roots are operator-
// approved migrations and retain full-file reads so adoption stays atomic.
const MAX_UNSCOPED_GROWTH_BYTES = 2 * 1024 * 1024;

export type RangeReader = (
  filePath: string,
  from: number,
  length: number,
) => Promise<Uint8Array>;

/** Everything one growth read needs, gathered by the caller that owns targeting. */
export interface GrowthRead {
  readonly source: ProviderSourceStat;
  readonly filePath: string;
  readonly checkpoint: IngestCheckpoint | null;
  readonly rangeReader: RangeReader;
}

interface GrowthContext {
  readonly read: GrowthRead;
  readonly size: number;
  readonly device: string;
  readonly inode: string;
}

const tailHash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

function growthResult(
  context: GrowthContext,
  sourceEpoch: number,
  fromOffset: number,
  priorTail: Uint8Array,
  bytes: Uint8Array,
): ProviderSourceGrowth {
  return {
    sourceId: context.read.source.sourceId,
    provider: context.read.source.provider,
    sourceEpoch,
    fromOffset,
    priorTail,
    bytes,
    signatureAtRead: { device: context.device, inode: context.inode },
  };
}

/** A symlink or a non-file cannot be tailed — the scan must re-classify it first. */
const requireRegularFile = (metadata: Stats): void => {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('provider source is not a regular file');
  }
};

/** Fresh filesystem facts for one read, guarded so only regular files proceed. */
const contextOf = async (read: GrowthRead): Promise<GrowthContext> => {
  const metadata = await lstat(read.filePath);
  requireRegularFile(metadata);
  return {
    read,
    size: metadata.size,
    device: String(metadata.dev),
    inode: String(metadata.ino),
  };
};

/** A new device, a new inode, or a shorter file means the file was replaced. */
const wasReplaced = (
  checkpoint: IngestCheckpoint,
  context: GrowthContext,
): boolean =>
  checkpoint.fileSignature.device !== context.device
  || checkpoint.fileSignature.inode !== context.inode
  || context.size < checkpoint.offset;

/** Adopted roots read whole files; unscoped files are capped so one file never monopolises a pass. */
const growthLimitFor = (context: GrowthContext): number =>
  context.read.source.adoptionEligible ? context.size : MAX_UNSCOPED_GROWTH_BYTES;

/** The whole file from offset zero — the first-read and the replaced-file answer. */
async function fullGrowth(
  context: GrowthContext,
  sourceEpoch: number,
): Promise<ProviderSourceGrowth> {
  const bytes = await context.read.rangeReader(
    context.read.filePath,
    0,
    Math.min(context.size, growthLimitFor(context)),
  );
  return growthResult(context, sourceEpoch, 0, Buffer.alloc(0), bytes);
}

/** The file has not moved since the checkpoint — nothing to read. */
const unchangedGrowth = (
  context: GrowthContext,
  checkpoint: IngestCheckpoint,
): ProviderSourceGrowth =>
  growthResult(context, checkpoint.sourceEpoch, checkpoint.offset, Buffer.alloc(0), Buffer.alloc(0));

/**
 * Reads one source's growth past its checkpoint. Crash recovery: this read is
 * pure — the caller persists the advanced checkpoint before applying lines, so
 * a crash mid-ingest re-reads from the last committed offset on next pass.
 */
export async function readSourceGrowth(read: GrowthRead): Promise<ProviderSourceGrowth> {
  const context = await contextOf(read);
  if (read.checkpoint === null) return fullGrowth(context, 0);
  if (wasReplaced(read.checkpoint, context)) {
    return fullGrowth(context, read.checkpoint.sourceEpoch + 1);
  }
  return committedGrowth(context, read.checkpoint);
}

/** Growth past a live checkpoint: none, verified-incremental, or a fresh start. */
async function committedGrowth(
  context: GrowthContext,
  checkpoint: IngestCheckpoint,
): Promise<ProviderSourceGrowth> {
  if (context.size === checkpoint.offset) return unchangedGrowth(context, checkpoint);
  if (checkpoint.offset === 0) return fullGrowth(context, checkpoint.sourceEpoch);
  return verifiedGrowth(context, checkpoint);
}

/**
 * Re-reads the committed tail to prove the file was appended to, not rewritten.
 * A matching tail yields incremental growth; a mismatch is a replacement.
 */
async function verifiedGrowth(
  context: GrowthContext,
  checkpoint: IngestCheckpoint,
): Promise<ProviderSourceGrowth> {
  const verifyFrom = Math.max(0, checkpoint.offset - VERIFY_BYTES);
  const committedLength = checkpoint.offset - verifyFrom;
  const window = Buffer.from(await context.read.rangeReader(
    context.read.filePath,
    verifyFrom,
    Math.min(context.size - verifyFrom, committedLength + growthLimitFor(context)),
  ));
  if (tailHash(window.subarray(0, committedLength)) !== checkpoint.fileSignature.tailHash) {
    return fullGrowth(context, checkpoint.sourceEpoch + 1);
  }
  return growthResult(
    context,
    checkpoint.sourceEpoch,
    checkpoint.offset,
    window.subarray(0, committedLength),
    window.subarray(committedLength),
  );
}
