// packages/transcript contract — TRN-001 (S2b). Raw copies under
// .novakai/transcripts/ are evidence blobs EXEMPT from the envelope law
// (§22 ruling 6); only transcriptLine objects (S3) will carry envelopes.

import type { ProviderName } from './schemas.js';

export * from './schemas.js';
export * from './errors.js';
export * from './source.js';
export {
  createRawTranscriptSource,
  type ProviderAgentResolver,
  type ProviderSessionResolver,
  type RawTranscriptSourceOptions,
} from '../adapters/raw-transcript-source.js';
export {
  createProviderIdentityResolvers,
  loadProviderIdentityRecords,
  type ProviderIdentityRecord,
  type ProviderIdentityResolvers,
} from '../adapters/provider-identity-resolvers.js';
export {
  composeTranscript,
  type ComposeTranscriptOptions,
} from '../core/composition.js';
export { type TranscriptContract } from '../core/contract.js';

export interface WatcherSource {
  provider: ProviderName;
  /** Provider session dir, watched RECURSIVELY for *.jsonl (subagent files included). */
  dir: string;
}

export interface WatcherOptions {
  /** .novakai/ root — copies land in transcripts/<provider>/, state in transcripts/.state/. */
  root: string;
  sources: WatcherSource[];
  /** Poll interval. fs.watch is flaky across editors/atomics; polling is the honest mechanism. */
  intervalMs?: number;
  /** Test seam: ranged content read (byte offset + length). EVERY content
   * read the scan performs goes through this, so a test can count bytes —
   * the 2026-08-09 churn fix's contract is "unchanged files read ZERO". */
  readRange?: (filePath: string, from: number, length: number) => Buffer;
}

export interface WatcherStatus {
  running: boolean;
  files: number;
  bytesCopied: number;
  lastScanAt: string | null;
  /** M6: per-file failures recorded as typed skips (scan never throws). */
  skips: Array<{ src: string; reason: string }>;
}

export interface TranscriptWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): WatcherStatus;
}
