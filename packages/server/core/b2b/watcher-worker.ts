import { parentPort, workerData } from 'node:worker_threads';
import {
  composeTranscript,
  createProviderIdentityResolvers,
  createRawTranscriptSource,
  createTranscriptWatcher,
  defaultSources,
  loadProviderIdentityRecords,
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
const identities = createProviderIdentityResolvers();
const transcript = composeTranscript({
  root: input.root,
  source: createRawTranscriptSource({
    root: input.root,
    resolveSessionRef: identities.resolveSessionRef,
    resolveAgentId: identities.resolveAgentId,
  }),
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
let triggerRequests: string[] = [];
let lastSuccessfulCustodyRevision: number | undefined;

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

function safeFailureMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const errorCode = raw.match(
    /\b(?:EACCES|EEXIST|EINVAL|EIO|ENOENT|ENOTDIR|EPERM)\b/u,
  )?.[0];
  return errorCode
    ? `transcript worker failed (${errorCode})`
    : 'transcript worker failed';
}

function fail(cause: unknown): void {
  parentPort?.postMessage({
    type: 'failed',
    message: safeFailureMessage(cause),
  });
  parentPort?.close();
}

async function runIngest(requestId?: string): Promise<void> {
  if (requestId) triggerRequests.push(requestId);
  if (!running || ingesting) return;
  const custodyRevision = watcher.status().bytesCopied;
  if (
    requestId === undefined
    && lastSuccessfulCustodyRevision === custodyRevision
  ) {
    schedule(input.ingestIntervalMs);
    return;
  }
  ingesting = true;
  postStatus();
  let outcome: Awaited<ReturnType<typeof transcript.ingest>> | undefined;
  activeIngest = (async () => {
    identities.replace(await loadProviderIdentityRecords(input.root));
    const result = await transcript.ingest();
    outcome = result;
    runs += 1;
    if (result.ok) {
      lastSuccessfulCustodyRevision = custodyRevision;
      lastResult = result.value;
      lastError = undefined;
    } else {
      lastError = `${result.error.code}: ${result.error.message}`;
    }
  })();
  try {
    await activeIngest;
  } catch (cause) {
    lastError = safeFailureMessage(cause);
    outcome = {
      ok: false,
      error: {
        code: 'TranscriptSourceFailed',
        message: 'transcript ingestion failed',
        details: { cause: 'ingestion worker failure' },
        retryable: true,
      },
    };
  } finally {
    activeIngest = null;
    ingesting = false;
    const completedRequests = triggerRequests;
    triggerRequests = [];
    if (outcome) {
      for (const completedRequest of completedRequests) {
        parentPort?.postMessage({
          type: 'ingest-result',
          requestId: completedRequest,
          result: outcome,
        });
      }
    }
    postStatus();
    schedule(input.ingestIntervalMs);
  }
}

parentPort?.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const type = (message as { type?: unknown }).type;
  if (type === 'ingest') {
    const requestId = (message as { requestId?: unknown }).requestId;
    if (typeof requestId === 'string') void runIngest(requestId);
    return;
  }
  if (type !== 'stop') return;
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
