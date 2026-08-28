import { watch, type FSWatcher } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Normalizes provider-root filesystem notifications for the source monitor. A
 * rename or missing path means the affected source cannot be targeted safely
 * and requires discovery.
 */
export interface RootWatchEvent {
  readonly eventType: 'change' | 'rename';
  readonly filePath?: string;
}

/**
 * Controls one set of recursive provider-root watchers. Refreshing idempotently
 * reconciles currently available roots; closing idempotently stops every
 * watcher and makes future refreshes no-ops.
 */
export interface TranscriptRootsWatcher {
  refresh(): Promise<void>;
  close(): void;
}

/**
 * Creates recursive watchers for currently available provider roots. Refreshing
 * attaches newly available roots and removes vanished ones. Watcher failures
 * trigger discovery; closing permanently stops notifications.
 */
export function createTranscriptRootsWatcher(
  configuredRoots: readonly string[],
  notify: (event: RootWatchEvent) => void,
): TranscriptRootsWatcher {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const refresh = async (): Promise<void> => {
    if (closed) return;
    const active = new Set<string>();
    for (const configuredRoot of configuredRoots) {
      let root: string;
      try {
        root = await realpath(configuredRoot);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw cause;
      }
      active.add(root);
      if (watchers.has(root)) continue;
      try {
        const watcher = watch(root, { recursive: true }, (eventType, filename) => {
          notify({
            eventType,
            ...(filename === null
              ? {}
              : { filePath: path.resolve(root, filename.toString()) }),
          });
        });
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(root);
          notify({ eventType: 'rename' });
        });
        watchers.set(root, watcher);
      } catch {
        notify({ eventType: 'rename' });
      }
    }
    for (const [root, watcher] of watchers) {
      if (active.has(root)) continue;
      watcher.close();
      watchers.delete(root);
    }
  };

  return {
    refresh,
    close() {
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
