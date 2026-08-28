import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ProviderSourceChange,
  ProviderSourceStat,
  ProviderSourceSubscription,
} from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptSourceId } from '../../contract/types.js';
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

  get(sourceId: TranscriptSourceId): DiscoveredSource | undefined {
    return this.discovered.get(sourceId);
  }

  async statKnown(
    sourceIds?: readonly TranscriptSourceId[],
  ): Promise<readonly ProviderSourceStat[]> {
    const selected = sourceIds === undefined
      ? [...this.discovered.values()]
      : sourceIds.flatMap((sourceId) => {
          const source = this.discovered.get(sourceId);
          return source === undefined ? [] : [source];
        });
    const refreshed: ProviderSourceStat[] = [];
    for (const source of selected) {
      let metadata;
      try {
        metadata = await lstat(source.filePath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw cause;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const next: DiscoveredSource = {
        ...source,
        size: metadata.size,
        device: String(metadata.dev),
        inode: String(metadata.ino),
        modifiedAt: metadata.mtime.toISOString(),
      };
      this.discovered.set(source.sourceId, next);
      refreshed.push(publicStat(next));
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
