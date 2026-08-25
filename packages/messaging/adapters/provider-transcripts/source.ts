import { createHash } from "node:crypto";
import { open, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ProviderSourceGrowth,
  ProviderSourceStat,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type { IngestCheckpoint } from "../../contract/records/ingest-checkpoint.js";
import type { ProviderName, TranscriptSourceId } from "../../contract/types.js";

const VERIFY_BYTES = 64;

/** Explicit provider session roots scanned by the read-only source adapter. */
export interface ProviderTranscriptRoots {
  readonly claude?: readonly string[];
  readonly codex?: readonly string[];
  readonly kimi?: readonly string[];
}

interface DiscoveredSource extends ProviderSourceStat {
  readonly filePath: string;
}

const sourceIdOf = (provider: ProviderName, root: string, relative: string): TranscriptSourceId =>
  `source_${createHash("sha256")
    .update(JSON.stringify([provider, root, relative.split(path.sep).join("/")]))
    .digest("hex")}` as TranscriptSourceId;

const tailHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function readRange(filePath: string, from: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, from + read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

async function listJsonl(root: string, current = ""): Promise<readonly string[]> {
  const directory = path.join(root, current);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = current ? path.join(current, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...await listJsonl(root, relative));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(relative);
  }
  return found;
}

function resumeHint(relative: string): string | undefined {
  const segments = relative.split(path.sep);
  for (const segment of segments.reverse()) {
    const stripped = segment.replace(/\.jsonl$/u, "");
    const uuid = stripped.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu)?.[0];
    if (uuid !== undefined) return uuid;
    if (/^session_[A-Za-z0-9-]+$/u.test(stripped)) return stripped;
  }
  return undefined;
}

async function discoverRoot(
  provider: ProviderName,
  configuredRoot: string,
): Promise<readonly DiscoveredSource[]> {
  let root: string;
  try {
    root = await realpath(configuredRoot);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const sources: DiscoveredSource[] = [];
  for (const relative of await listJsonl(root)) {
    const filePath = path.join(root, relative);
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    const sourceId = sourceIdOf(provider, root, relative);
    const hint = resumeHint(relative);
    sources.push({
      sourceId,
      provider,
      size: metadata.size,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      filePath,
      ...(hint === undefined ? {} : { resumeIdHint: hint }),
    });
  }
  return sources;
}

interface GrowthContext {
  readonly source: ProviderSourceStat;
  readonly filePath: string;
  readonly size: number;
  readonly device: string;
  readonly inode: string;
}

function growthResult(
  context: GrowthContext,
  sourceEpoch: number,
  fromOffset: number,
  priorTail: Uint8Array,
  bytes: Uint8Array,
): ProviderSourceGrowth {
  return {
    sourceId: context.source.sourceId,
    provider: context.source.provider,
    sourceEpoch,
    fromOffset,
    priorTail,
    bytes,
    signatureAtRead: { device: context.device, inode: context.inode },
  };
}

class FileProviderTranscriptSource implements ProviderTranscriptSource {
  private discovered = new Map<TranscriptSourceId, DiscoveredSource>();

  constructor(
    private readonly roots: ProviderTranscriptRoots,
    private readonly rangeReader: (
      filePath: string,
      from: number,
      length: number,
    ) => Promise<Uint8Array>,
  ) {}

  async scan(): Promise<readonly ProviderSourceStat[]> {
    const next = new Map<TranscriptSourceId, DiscoveredSource>();
    for (const provider of ["claude", "codex", "kimi"] as const) {
      for (const configuredRoot of this.roots[provider] ?? []) {
        for (const source of await discoverRoot(provider, configuredRoot)) {
          next.set(source.sourceId, source);
        }
      }
    }
    this.discovered = next;
    return [...next.values()].map(({ filePath: _hidden, ...source }) => source);
  }

  async readGrowth(
    source: ProviderSourceStat,
    checkpoint: IngestCheckpoint | null,
  ): Promise<ProviderSourceGrowth> {
    const discovered = this.discovered.get(source.sourceId);
    if (discovered === undefined) throw new Error("provider source was not scanned");
    const metadata = await lstat(discovered.filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("provider source is not a regular file");
    }
    const device = String(metadata.dev);
    const inode = String(metadata.ino);
    const context = {
      source,
      filePath: discovered.filePath,
      size: metadata.size,
      device,
      inode,
    };
    const replaced = checkpoint !== null && (
      checkpoint.fileSignature.device !== device
      || checkpoint.fileSignature.inode !== inode
      || metadata.size < checkpoint.offset
    );
    let sourceEpoch = checkpoint?.sourceEpoch ?? 0;
    let fromOffset = replaced ? 0 : checkpoint?.offset ?? 0;
    if (replaced) sourceEpoch += 1;
    if (checkpoint !== null && !replaced && metadata.size === checkpoint.offset) {
      return growthResult(context, sourceEpoch, fromOffset, Buffer.alloc(0), Buffer.alloc(0));
    }
    if (checkpoint !== null && !replaced && checkpoint.offset > 0) {
      const verifyFrom = Math.max(0, checkpoint.offset - VERIFY_BYTES);
      const window = Buffer.from(await this.rangeReader(
        discovered.filePath,
        verifyFrom,
        metadata.size - verifyFrom,
      ));
      const committedBytes = checkpoint.offset - verifyFrom;
      if (tailHash(window.subarray(0, committedBytes)) !== checkpoint.fileSignature.tailHash) {
        sourceEpoch += 1;
        fromOffset = 0;
        const bytes = await this.rangeReader(discovered.filePath, 0, metadata.size);
        return growthResult(context, sourceEpoch, fromOffset, Buffer.alloc(0), bytes);
      }
      return growthResult(
        context,
        sourceEpoch,
        fromOffset,
        window.subarray(0, committedBytes),
        window.subarray(committedBytes),
      );
    }
    const bytes = await this.rangeReader(
      discovered.filePath,
      fromOffset,
      metadata.size - fromOffset,
    );
    return growthResult(context, sourceEpoch, fromOffset, Buffer.alloc(0), bytes);
  }
}

/** Creates the only read-only adapter over provider-owned session files. */
export const createProviderTranscriptSource = (
  roots: ProviderTranscriptRoots,
  instrumentation: {
    readonly readRange?: (
      filePath: string,
      from: number,
      length: number,
    ) => Promise<Uint8Array>;
  } = {},
): ProviderTranscriptSource => new FileProviderTranscriptSource(
  roots,
  instrumentation.readRange ?? readRange,
);
