import { parentPort, workerData } from 'node:worker_threads';
import {
  createTranscriptWatcher,
  defaultSources,
} from '../../../transcript/contract/index.js';

interface WatcherWorkerInput {
  root: string;
  providerHome?: string;
  intervalMs: number;
}

const input = workerData as WatcherWorkerInput;
const watcher = createTranscriptWatcher({
  root: input.root,
  sources: defaultSources(input.providerHome),
  intervalMs: input.intervalMs,
});

parentPort?.on('message', (message: unknown) => {
  if (
    typeof message !== 'object'
    || message === null
    || (message as { type?: unknown }).type !== 'stop'
  ) {
    return;
  }
  void watcher.stop().finally(() => {
    parentPort?.postMessage({ type: 'stopped' });
    parentPort?.close();
  });
});

void watcher.start()
  .then(() => {
    parentPort?.postMessage({
      type: 'ready',
      status: watcher.status(),
    });
  })
  .catch((cause: unknown) => {
    parentPort?.postMessage({
      type: 'failed',
      message: cause instanceof Error ? cause.message : String(cause),
    });
    parentPort?.close();
  });
