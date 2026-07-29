import { Worker } from 'node:worker_threads';
import {
  composeTranscript,
  createRawTranscriptSource,
  type IngestResult,
  type TranscriptContract,
} from '../../../transcript/contract/index.js';

const DEFAULT_POLL_MS = 250;

export interface TranscriptTopologyStatus {
  running: boolean;
  watcherReady: boolean;
  ingesting: boolean;
  runs: number;
  lastResult?: IngestResult;
  lastError?: string;
}

export interface TranscriptTopology {
  start(): void;
  stop(): Promise<void>;
  status(): TranscriptTopologyStatus;
}

export interface TranscriptServerHost {
  readonly operations: TranscriptContract;
  readonly topology: TranscriptTopology;
}

export interface ComposeTranscriptServerHostOptions {
  root: string;
  providerHome?: string;
  watcherIntervalMs?: number;
  ingestIntervalMs?: number;
}

/**
 * Server owns only host topology. Transcript remains authoritative for every
 * durable line, journal entry, checkpoint, and query.
 */
export function composeTranscriptServerHost(
  options: ComposeTranscriptServerHostOptions,
): TranscriptServerHost {
  const operations = composeTranscript({
    root: options.root,
    source: createRawTranscriptSource({ root: options.root }),
  });
  const intervalMs = options.ingestIntervalMs ?? DEFAULT_POLL_MS;
  const watcherIntervalMs = options.watcherIntervalMs ?? DEFAULT_POLL_MS;
  let running = false;
  let watcherReady = false;
  let ingesting = false;
  let runs = 0;
  let lastResult: IngestResult | undefined;
  let lastError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let worker: Worker | null = null;
  let activeIngest: Promise<void> | null = null;
  let stopWorker: (() => void) | null = null;

  const snapshot = (): TranscriptTopologyStatus => ({
    running,
    watcherReady,
    ingesting,
    runs,
    ...(lastResult ? { lastResult } : {}),
    ...(lastError ? { lastError } : {}),
  });

  const schedule = (delayMs: number): void => {
    if (!running || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void runIngest();
    }, delayMs);
  };

  const runIngest = async (): Promise<void> => {
    if (!running || ingesting) return;
    ingesting = true;
    activeIngest = (async () => {
      const result = await operations.ingest();
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
      schedule(intervalMs);
    }
  };

  const topology: TranscriptTopology = {
    start() {
      if (running) return;
      running = true;
      watcherReady = false;
      lastError = undefined;
      worker = new Worker(
        new URL('./watcher-worker.js', import.meta.url),
        {
          workerData: {
            root: options.root,
            ...(options.providerHome
              ? { providerHome: options.providerHome }
              : {}),
            intervalMs: watcherIntervalMs,
          },
        },
      );
      worker.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null) return;
        const type = (message as { type?: unknown }).type;
        if (type === 'ready') {
          watcherReady = true;
          schedule(0);
        } else if (type === 'failed') {
          lastError = String(
            (message as { message?: unknown }).message
            ?? 'transcript watcher failed',
          );
        } else if (type === 'stopped') {
          stopWorker?.();
        }
      });
      worker.on('error', (cause) => {
        lastError = cause.message;
        stopWorker?.();
      });
      worker.on('exit', () => {
        stopWorker?.();
      });
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (activeIngest) await activeIngest;
      const currentWorker = worker;
      worker = null;
      if (!currentWorker) return;
      await new Promise<void>((resolve) => {
        stopWorker = resolve;
        currentWorker.postMessage({ type: 'stop' });
      });
      stopWorker = null;
      await currentWorker.terminate();
      watcherReady = false;
    },
    status: snapshot,
  };

  return { operations, topology };
}
