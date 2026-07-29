import { Worker } from 'node:worker_threads';
import {
  composeTranscript,
  createProviderIdentityResolvers,
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

export type TranscriptQueries = Pick<
  TranscriptContract,
  'linesBySession' | 'linesByProvider' | 'subagentTree'
>;

export interface TranscriptServerHost {
  readonly operations: TranscriptQueries;
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
  const identities = createProviderIdentityResolvers();
  const operations = composeTranscript({
    root: options.root,
    source: createRawTranscriptSource({
      root: options.root,
      resolveSessionRef: identities.resolveSessionRef,
      resolveAgentId: identities.resolveAgentId,
    }),
  });
  const watcherIntervalMs = options.watcherIntervalMs ?? DEFAULT_POLL_MS;
  const ingestIntervalMs = options.ingestIntervalMs ?? DEFAULT_POLL_MS;
  let phase: 'idle' | 'running' | 'stopping' | 'terminal' = 'idle';
  let watcherReady = false;
  let ingesting = false;
  let runs = 0;
  let lastResult: IngestResult | undefined;
  let ingestError: string | undefined;
  let terminalError: string | undefined;
  let worker: Worker | null = null;
  let workerExit: Promise<number> | null = null;
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

  const latchTerminal = (message: string): void => {
    if (!terminalError) terminalError = message;
    phase = 'terminal';
    watcherReady = false;
    ingesting = false;
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
            watcherIntervalMs,
            ingestIntervalMs,
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
        if (type === 'status') {
          if (phase !== 'running') return;
          const status = message as {
            watcherReady?: unknown;
            ingesting?: unknown;
            runs?: unknown;
            lastResult?: unknown;
            lastError?: unknown;
          };
          if (
            typeof status.watcherReady !== 'boolean'
            || typeof status.ingesting !== 'boolean'
            || typeof status.runs !== 'number'
          ) {
            latchTerminal('transcript worker sent an invalid status');
            void startedWorker.terminate();
            return;
          }
          watcherReady = status.watcherReady;
          ingesting = status.ingesting;
          runs = status.runs;
          if (status.lastResult !== undefined) {
            lastResult = status.lastResult as IngestResult;
          }
          ingestError = typeof status.lastError === 'string'
            ? status.lastError
            : undefined;
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
        } else if (phase === 'stopping' && code !== 0) {
          latchTerminal(
            `transcript watcher failed while stopping with code ${code}`,
          );
        }
      });
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const terminal = phase === 'terminal';
        if (phase === 'idle') return;
        if (!terminal) phase = 'stopping';
        const currentWorker = worker;
        const currentExit = workerExit;
        if (currentWorker && !terminal) {
          currentWorker.postMessage({ type: 'stop' });
        }
        if (currentExit) await currentExit;
        worker = null;
        workerExit = null;
        watcherReady = false;
        ingesting = false;
        if (!terminal && !terminalError) phase = 'idle';
      })();
      try {
        await stopPromise;
      } finally {
        stopPromise = null;
      }
    },
    status: snapshot,
  };

  return {
    operations: {
      linesBySession: operations.linesBySession,
      linesByProvider: operations.linesByProvider,
      subagentTree: operations.subagentTree,
    },
    topology,
  };
}
