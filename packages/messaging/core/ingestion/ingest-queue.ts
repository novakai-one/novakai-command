import type { Outcome } from '../../contract/outcome.js';
import type { IngestResult } from '../../contract/runtime.js';
import type { ProviderSourceChange } from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptSourceId } from '../../contract/types.js';

/**
 * Serializes ingestion while coalescing duplicate filesystem notifications.
 * Discovery supersedes targeted work; notifications arriving during ingestion
 * are drained before the active request completes.
 */
export class ProviderIngestQueue {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingDiscovery = false;
  private readonly pendingSourceIds = new Set<TranscriptSourceId>();
  private inFlight: Promise<Outcome<IngestResult>> | undefined;

  constructor(
    private readonly debounceMs: number,
    private readonly run: (
      sourceIds?: readonly TranscriptSourceId[],
    ) => Promise<Outcome<IngestResult>>,
  ) {}

  get active(): boolean {
    return this.inFlight !== undefined;
  }

  /** Records a filesystem change notification; work starts after the debounce window. */
  notify(change: ProviderSourceChange): void {
    if (change.kind === 'discovery') {
      this.pendingDiscovery = true;
      this.pendingSourceIds.clear();
    } else if (!this.pendingDiscovery) {
      this.pendingSourceIds.add(change.sourceId);
    }
    if (this.inFlight !== undefined || this.debounceTimer !== undefined) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.ensureDrain();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  /** Runs a full discovery pass now, superseding any debounced targeted work. */
  requestDiscovery(): Promise<Outcome<IngestResult>> {
    this.pendingDiscovery = true;
    this.pendingSourceIds.clear();
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    return this.ensureDrain();
  }

  /** Drops queued-but-unstarted work; an in-flight pass still completes. */
  cancelPending(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.pendingDiscovery = false;
    this.pendingSourceIds.clear();
  }

  /** Resolves once no ingestion pass is in flight; used by shutdown. */
  async waitForIdle(): Promise<void> {
    if (this.inFlight !== undefined) await this.inFlight;
  }

  private ensureDrain(): Promise<Outcome<IngestResult>> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = this.drain();
    return this.inFlight;
  }

  private async drain(): Promise<Outcome<IngestResult>> {
    let last: Outcome<IngestResult> | undefined;
    try {
      do {
        const discovery = this.pendingDiscovery;
        const sourceIds = [...this.pendingSourceIds];
        this.pendingDiscovery = false;
        this.pendingSourceIds.clear();
        last = await this.run(discovery ? undefined : sourceIds);
      } while (this.pendingDiscovery || this.pendingSourceIds.size > 0);
      return last!;
    } finally {
      this.inFlight = undefined;
    }
  }
}
