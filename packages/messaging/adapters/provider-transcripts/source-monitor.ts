import { lstat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type {
  ProviderSourceChange,
  ProviderSourceStat,
  ProviderSourceSubscription,
} from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptSourceId } from '../../contract/types.js';
import { isErrno } from '../../core/thrown.js';
import {
  createTranscriptRootsWatcher,
  type TranscriptRootsWatcher,
} from './roots-watcher.js';

/**
 * Adds a canonical filesystem path to public source metadata for adapter-only
 * targeting. The path never crosses the provider-source contract or persistence
 * boundary.
 */
export interface DiscoveredSource extends ProviderSourceStat {
  readonly filePath: string;
}

const publicStat = ({ filePath: _hidden, ...source }: DiscoveredSource): ProviderSourceStat =>
  source;

/** Fresh metadata for one path, or nothing when the file vanished mid-pass. */
const statExisting = async (filePath: string): Promise<Stats | undefined> => {
  try {
    return await lstat(filePath);
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return undefined;
    throw cause;
  }
};

/**
 * Keeps provider filesystem paths inside the adapter while exposing opaque
 * source IDs. Full discovery replaces its known-source map; targeted refreshes
 * never walk directories and omit vanished files from their results.
 */
export class ProviderSourceMonitor {
  private discovered = new Map<TranscriptSourceId, DiscoveredSource>();
  private sourceIdByPath = new Map<string, TranscriptSourceId>();
  private rootsWatcher: TranscriptRootsWatcher | undefined;

  constructor(private readonly configuredRoots: readonly string[]) {}

  async replace(sources: readonly DiscoveredSource[]): Promise<readonly ProviderSourceStat[]> {
    this.discovered = new Map(sources.map((source) => [source.sourceId, source]));
    this.sourceIdByPath = new Map(
      sources.map((source) => [path.resolve(source.filePath), source.sourceId]),
    );
    await this.rootsWatcher?.refresh();
    return sources.map(publicStat);
  }

  find(sourceId: TranscriptSourceId): DiscoveredSource | undefined {
    return this.discovered.get(sourceId);
  }

  /** The sources a targeted refresh covers — everything when no targets are given. */
  private selected(sourceIds?: readonly TranscriptSourceId[]): readonly DiscoveredSource[] {
    if (sourceIds === undefined) return [...this.discovered.values()];
    return sourceIds.flatMap((sourceId) => {
      const source = this.discovered.get(sourceId);
      return source === undefined ? [] : [source];
    });
  }

  /** Re-stats one source and updates the map, or skips it when the file is gone. */
  private async refreshOne(source: DiscoveredSource): Promise<ProviderSourceStat | undefined> {
    const metadata = await statExisting(source.filePath);
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      return undefined;
    }
    const next: DiscoveredSource = {
      ...source,
      size: metadata.size,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      modifiedAt: metadata.mtime.toISOString(),
    };
    this.discovered.set(source.sourceId, next);
    return publicStat(next);
  }

  async statKnown(
    sourceIds?: readonly TranscriptSourceId[],
  ): Promise<readonly ProviderSourceStat[]> {
    const refreshed: ProviderSourceStat[] = [];
    for (const source of this.selected(sourceIds)) {
      const next = await this.refreshOne(source);
      if (next !== undefined) refreshed.push(next);
    }
    return refreshed;
  }

  async watchChanges(
    notify: (change: ProviderSourceChange) => void,
  ): Promise<ProviderSourceSubscription> {
    this.rootsWatcher?.close();
    const watcher = createTranscriptRootsWatcher(this.configuredRoots, (event) => {
      if (event.eventType === 'rename' || event.filePath === undefined) {
        notify({ kind: 'discovery' });
        return;
      }
      const sourceId = this.sourceIdByPath.get(path.resolve(event.filePath));
      notify(sourceId === undefined
        ? { kind: 'discovery' }
        : { kind: 'source', sourceId });
    });
    this.rootsWatcher = watcher;
    await watcher.refresh();
    return {
      close: () => {
        if (this.rootsWatcher !== watcher) return;
        watcher.close();
        this.rootsWatcher = undefined;
      },
    };
  }
}
