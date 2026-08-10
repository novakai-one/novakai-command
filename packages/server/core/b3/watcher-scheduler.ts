// Runtime-owned clock adapter for Supervision's durable WatchDeadlines.
//
// The timer owns no watcher policy and no state. Each pass asks Supervision to
// re-read its authoritative rows and settle only deadlines whose persisted
// dueAt has arrived. A restart therefore resumes from JSONL rather than from an
// in-memory timeout that died with the old Runtime.
import { nowIsoUtc } from '@novakai/foundation/contract';
import type { SupervisionCore } from '../../../supervision/public/index.js';

export interface WatcherScheduler {
  stop(): Promise<void>;
}

export interface WatcherSchedulerOptions {
  readonly intervalMs?: number;
  readonly reportFailure?: (message: string) => void;
}

// 2026-08-09: 100 ms ticks wrote a commandReceipt pair (create+settle, with
// traces and fsyncs) ~10×/second forever — ~0.7 GB/day of receipt+trace growth
// for deadlines whose own cadence is 300 s. 1 s granularity is ample.
const DEFAULT_INTERVAL_MS = 1000;

/** Start one bounded, non-overlapping deadline pass loop. */
export function startWatcherScheduler(
  supervision: SupervisionCore,
  options: WatcherSchedulerOptions = {},
): WatcherScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const reportFailure = options.reportFailure ?? ((message: string) => {
    console.error(`[supervision-scheduler] ${message}`);
  });
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const scan = async (): Promise<void> => {
    try {
      const outcome = await supervision.evaluateDueDeadlines(nowIsoUtc());
      if (!outcome.ok) {
        reportFailure(`${outcome.error.code}: ${outcome.error.message}`);
      }
    } catch (cause) {
      reportFailure(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const tick = (): void => {
    if (stopped || inFlight !== null) return;
    inFlight = scan().finally(() => { inFlight = null; });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
