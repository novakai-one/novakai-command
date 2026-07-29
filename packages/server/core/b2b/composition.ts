import { Worker } from 'node:worker_threads';
import {
  composeTranscript,
  createRawTranscriptSource,
  type IngestResult,
  type TranscriptContract,
} from '../../../transcript/contract/index.js';

const DEFAULT_POLL_MS = 1_000;

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
  let phase: 'idle' | 'running' | 'stopping' | 'terminal' = 'idle';
  let watcherReady = false;
  let ingesting = false;
  let runs = 0;
  let lastResult: IngestResult | undefined;
  let ingestError: string | undefined;
  let terminalError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let worker: Worker | null = null;
  let workerExit: Promise<number> | null = null;
  let activeIngest: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const snapshot = (): TranscriptTopologyStatus => ({
    running: phase === 'running',
    watcherReady,
    ingesting,
    runs,
    ...(lastResult ? { lastResult } : {}),
    ...(terminalError ?? ingestError
      ? { lastError: terminalError ?? ingestError }
      : {}),
  });

  const schedule = (delayMs: number): void => {
    if (phase !== 'running' || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void runIngest();
    }, delayMs);
  };

  const runIngest = async (): Promise<void> => {
    if (phase !== 'running' || ingesting) return;
    ingesting = true;
    activeIngest = (async () => {
      const result = await operations.ingest();
      runs += 1;
      if (result.ok) {
        lastResult = result.value;
        ingestError = undefined;
      } else {
        ingestError = `${result.error.code}: ${result.error.message}`;
      }
    })();
    try {
      await activeIngest;
    } catch (cause) {
      ingestError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      activeIngest = null;
      ingesting = false;
      schedule(intervalMs);
    }
  };

  const latchTerminal = (message: string): void => {
    if (!terminalError) terminalError = message;
    phase = 'terminal';
    watcherReady = false;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const topology: TranscriptTopology = {
    start() {
      if (phase !== 'idle' || terminalError) return;
      phase = 'running';
      watcherReady = false;
      ingestError = undefined;
      const startedWorker = new Worker(
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
      worker = startedWorker;
      workerExit = new Promise<number>((resolve) => {
        startedWorker.once('exit', resolve);
      });
      startedWorker.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null) return;
        const type = (message as { type?: unknown }).type;
        if (type === 'ready') {
          if (phase !== 'running') return;
          watcherReady = true;
          schedule(0);
        } else if (type === 'failed') {
          latchTerminal(String(
            (message as { message?: unknown }).message
            ?? 'transcript watcher failed',
          ));
        }
      });
      startedWorker.on('error', (cause) => {
        latchTerminal(cause.message);
      });
      startedWorker.on('exit', (code) => {
        if (phase === 'running') {
          latchTerminal(
            `transcript watcher exited unexpectedly with code ${code}`,
          );
        }
      });
      schedule(0);
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const terminal = phase === 'terminal';
        if (phase === 'idle') return;
        if (!terminal) phase = 'stopping';
        if (timer) clearTimeout(timer);
        timer = null;
        if (activeIngest) await activeIngest;
        const currentWorker = worker;
        const currentExit = workerExit;
        if (currentWorker && !terminal) {
          currentWorker.postMessage({ type: 'stop' });
        }
        if (currentExit) await currentExit;
        worker = null;
        workerExit = null;
        watcherReady = false;
        if (!terminal) phase = 'idle';
      })();
      try {
        await stopPromise;
      } finally {
        stopPromise = null;
      }
    },
    status: snapshot,
  };

  return { operations, topology };
}
