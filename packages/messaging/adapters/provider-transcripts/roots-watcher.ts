import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { existingRoots } from './available-roots.js';

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

  /** One root's events, normalized; a dead watcher asks for rediscovery. */
  const attach = (root: string): void => {
    if (watchers.has(root)) return;
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
      // A root that cannot be watched (permissions, race with deletion) is
      // treated like a rename: the monitor falls back to full discovery.
      notify({ eventType: 'rename' });
    }
  };

  /** Watchers whose root vanished are closed so only live roots notify. */
  const detachVanished = (active: ReadonlySet<string>): void => {
    for (const [root, watcher] of watchers) {
      if (active.has(root)) continue;
      watcher.close();
      watchers.delete(root);
    }
  };

  const refresh = async (): Promise<void> => {
    if (closed) return;
    const active = new Set(await existingRoots(configuredRoots));
    detachVanished(active);
    for (const root of active) attach(root);
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
