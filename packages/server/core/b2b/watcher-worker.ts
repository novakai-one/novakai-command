import { parentPort, workerData } from 'node:worker_threads';
import {
  composeTranscript,
  createRawTranscriptSource,
  createTranscriptWatcher,
  defaultSources,
  type IngestResult,
} from '../../../transcript/contract/index.js';

interface WatcherWorkerInput {
  root: string;
  providerHome?: string;
  watcherIntervalMs: number;
  ingestIntervalMs: number;
}

const input = workerData as WatcherWorkerInput;
const watcher = createTranscriptWatcher({
  root: input.root,
  sources: defaultSources(input.providerHome),
  intervalMs: input.watcherIntervalMs,
});
const transcript = composeTranscript({
  root: input.root,
  source: createRawTranscriptSource({ root: input.root }),
});
let running = true;
let watcherReady = false;
let ingesting = false;
let runs = 0;
let lastResult: IngestResult | undefined;
let lastError: string | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let activeIngest: Promise<void> | null = null;
let stopping: Promise<void> | null = null;

function postStatus(): void {
  parentPort?.postMessage({
    type: 'status',
    watcherReady,
    ingesting,
    runs,
    ...(lastResult ? { lastResult } : {}),
    ...(lastError ? { lastError } : {}),
  });
}

function schedule(delayMs: number): void {
  if (!running || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void runIngest();
  }, delayMs);
}

function fail(cause: unknown): void {
  parentPort?.postMessage({
    type: 'failed',
    message: cause instanceof Error ? cause.message : String(cause),
  });
  parentPort?.close();
}

async function runIngest(): Promise<void> {
  if (!running || ingesting) return;
  ingesting = true;
  postStatus();
  activeIngest = (async () => {
    const result = await transcript.ingest();
    runs += 1;
    if (result.ok) {
      lastResult = result.value;
      lastError = undefined;
    } else {
      lastError = `${result.error.code}: ${result.error.message}`;
    }
  })();
  try {
    await activeIngest;
  } catch (cause) {
    lastError = cause instanceof Error ? cause.message : String(cause);
  } finally {
    activeIngest = null;
    ingesting = false;
    postStatus();
    schedule(input.ingestIntervalMs);
  }
}

parentPort?.on('message', (message: unknown) => {
  if (
    typeof message !== 'object'
    || message === null
    || (message as { type?: unknown }).type !== 'stop'
  ) {
    return;
  }
  if (stopping) return;
  stopping = (async () => {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (activeIngest) {
      try {
        await activeIngest;
      } catch {
        // runIngest owns reporting the ingest failure.
      }
    }
    await watcher.stop();
    parentPort?.postMessage({ type: 'stopped' });
    parentPort?.close();
  })().catch(fail);
});

void watcher.start()
  .then(() => {
    watcherReady = true;
    postStatus();
    schedule(0);
  })
  .catch(fail);
