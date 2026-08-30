import { createHash } from 'node:crypto';
import { open, lstat, readdir, type FileHandle } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type {
  ProviderSourceChange,
  ProviderSourceGrowth,
  ProviderSourceStat,
  ProviderSourceSubscription,
  ProviderTranscriptSource,
} from '../../contract/ports/provider-transcript-source.js';
import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';
import { parseTranscriptSourceId } from '../../contract/transcript-source-id.js';
import type { ProviderName, TranscriptSourceId } from '../../contract/types.js';
import { compareStrings } from '../../core/compare.js';
import { isErrno } from '../../core/thrown.js';
import { existingRoots } from './available-roots.js';
import { readSourceGrowth, type RangeReader } from './growth.js';
import {
  ProviderSourceMonitor,
  type DiscoveredSource,
} from './source-monitor.js';

/** Explicit provider session roots scanned by the read-only source adapter. */
export interface ProviderTranscriptRoots {
  readonly claude?: readonly string[];
  readonly codex?: readonly string[];
  readonly kimi?: readonly string[];
}

/**
 * One source id is a hash of provider, root and relative path. The mint is
 * checked against the contract pattern, so a malformed id is a defect here,
 * never a value a caller can observe.
 */
const sourceIdOf = (provider: ProviderName, root: string, relative: string): TranscriptSourceId => {
  const minted = parseTranscriptSourceId(`source_${createHash('sha256')
    .update(JSON.stringify([provider, root, relative.split(path.sep).join('/')]))
    .digest('hex')}`);
  if (minted === undefined) throw new Error('provider source id mint violated the contract pattern');
  return minted;
};

/** Reads until the range is full or the file ends; a short tail shrinks the buffer. */
const readFully = async (
  handle: FileHandle,
  from: number,
  length: number,
): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, from + read);
    if (result.bytesRead === 0) break;
    read += result.bytesRead;
  }
  return buffer.subarray(0, read);
};

async function readRange(filePath: string, from: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, 'r');
  try {
    return await readFully(handle, from, length);
  } finally {
    await handle.close();
  }
}

/** A directory's entries, or nothing when the directory vanished mid-pass. */
const listEntries = async (directory: string): Promise<readonly Dirent[] | undefined> => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return undefined;
    throw cause;
  }
};

type EntryKind = 'directory' | 'jsonl' | 'skip';

/** Only regular .jsonl files and directories take part in discovery. */
const classifyEntry = (entry: Dirent): EntryKind => {
  if (entry.isSymbolicLink()) return 'skip';
  if (entry.isDirectory()) return 'directory';
  return isJsonlFile(entry) ? 'jsonl' : 'skip';
};

const isJsonlFile = (entry: Dirent): boolean =>
  entry.isFile() && entry.name.endsWith('.jsonl');

/** One entry's contribution: a subtree listing, itself, or nothing. */
const collectEntry = async (
  root: string,
  current: string,
  entry: Dirent,
): Promise<readonly string[]> => {
  const relative = current ? path.join(current, entry.name) : entry.name;
  if (classifyEntry(entry) === 'directory') return listJsonl(root, relative);
  return classifyEntry(entry) === 'jsonl' ? [relative] : [];
};

async function listJsonl(root: string, current = ''): Promise<readonly string[]> {
  const entries = await listEntries(path.join(root, current));
  if (entries === undefined) return [];
  const sorted = [...entries].sort((left, right) => compareStrings(left.name, right.name));
  const collected = await Promise.all(sorted.map((entry) => collectEntry(root, current, entry)));
  return collected.flat();
}

/** One path segment's hint: a uuid when present, else a session_ name. */
const segmentHint = (segment: string): string | undefined => {
  const stripped = segment.replace(/\.jsonl$/u, '');
  const uuid = stripped.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu)?.[0];
  if (uuid !== undefined) return uuid;
  return /^session_[A-Za-z0-9-]+$/u.test(stripped) ? stripped : undefined;
};

/** A resume hint is the uuid or session_ name nearest the file itself. */
function resumeHint(relative: string): string | undefined {
  const segments = relative.split(path.sep).reverse();
  for (const segment of segments) {
    const hint = segmentHint(segment);
    if (hint !== undefined) return hint;
  }
  return undefined;
}

/** One file's discovery facts, marked adoption-eligible when it lives under an approved root. */
const discoveredSource = (
  provider: ProviderName,
  root: string,
  relative: string,
  metadata: { readonly size: number; readonly dev: number; readonly ino: number; readonly mtime: Date },
  adoptRoots: readonly string[],
): DiscoveredSource => {
  const filePath = path.join(root, relative);
  const hint = resumeHint(relative);
  return {
    sourceId: sourceIdOf(provider, root, relative),
    provider,
    size: metadata.size,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    modifiedAt: metadata.mtime.toISOString(),
    adoptionEligible: adoptRoots.some((candidate) =>
      filePath === candidate || filePath.startsWith(`${candidate}${path.sep}`)),
    filePath,
    ...(hint === undefined ? {} : { resumeIdHint: hint }),
  };
};

/** One relative path's discovery facts, or nothing when it is not a regular file. */
const discoverOne = async (
  provider: ProviderName,
  root: string,
  relative: string,
  adoptRoots: readonly string[],
): Promise<DiscoveredSource | undefined> => {
  const metadata = await lstat(path.join(root, relative));
  if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
  return discoveredSource(provider, root, relative, metadata, adoptRoots);
};

async function discoverRoot(
  provider: ProviderName,
  configuredRoot: string,
  adoptRoots: readonly string[],
): Promise<readonly DiscoveredSource[]> {
  const [root] = await existingRoots([configuredRoot]);
  if (root === undefined) return [];
  const discovered = await Promise.all(
    (await listJsonl(root)).map((relative) => discoverOne(provider, root, relative, adoptRoots)),
  );
  return discovered.filter((source): source is DiscoveredSource => source !== undefined);
}

class FileProviderTranscriptSource implements ProviderTranscriptSource {
  private readonly monitor: ProviderSourceMonitor;

  constructor(
    private readonly roots: ProviderTranscriptRoots,
    private readonly adoptRoots: ProviderTranscriptRoots,
    private readonly rangeReader: RangeReader,
  ) {
    this.monitor = new ProviderSourceMonitor([...new Set([
      ...(roots.claude ?? []),
      ...(roots.codex ?? []),
      ...(roots.kimi ?? []),
    ])]);
  }

  async scan(): Promise<readonly ProviderSourceStat[]> {
    const discovered = await Promise.all(
      (['claude', 'codex', 'kimi'] as const).map((provider) => this.discoverProvider(provider)),
    );
    return this.monitor.replace(discovered.flat());
  }

  /** Every source one provider's roots currently yield. */
  private async discoverProvider(provider: ProviderName): Promise<readonly DiscoveredSource[]> {
    const adoptRoots = await existingRoots(this.adoptRoots[provider] ?? []);
    const roots = this.roots[provider] ?? [];
    const discovered = await Promise.all(
      roots.map((root) => discoverRoot(provider, root, adoptRoots)),
    );
    return discovered.flat();
  }

  async statKnown(
    sourceIds?: readonly TranscriptSourceId[],
  ): Promise<readonly ProviderSourceStat[]> {
    return this.monitor.statKnown(sourceIds);
  }

  async watchChanges(
    notify: (change: ProviderSourceChange) => void,
  ): Promise<ProviderSourceSubscription> {
    return this.monitor.watchChanges(notify);
  }

  async readGrowth(
    source: ProviderSourceStat,
    checkpoint: IngestCheckpoint | null,
  ): Promise<ProviderSourceGrowth> {
    const discovered = this.monitor.find(source.sourceId);
    if (discovered === undefined) throw new Error('provider source was not scanned');
    return readSourceGrowth({
      source,
      filePath: discovered.filePath,
      checkpoint,
      rangeReader: this.rangeReader,
    });
  }
}

/**
 * Creates a read-only provider source whose filesystem paths remain private to
 * the adapter. Its first scan builds the targeted-source map reused by metadata
 * refreshes and change notifications; missing roots remain dormant until later
 * discovery finds them.
 */
export const createProviderTranscriptSource = (
  roots: ProviderTranscriptRoots,
  instrumentation: {
    readonly adoptRoots?: ProviderTranscriptRoots;
    readonly readRange?: RangeReader;
  } = {},
): ProviderTranscriptSource => new FileProviderTranscriptSource(
  roots,
  instrumentation.adoptRoots ?? {},
  instrumentation.readRange ?? readRange,
);
