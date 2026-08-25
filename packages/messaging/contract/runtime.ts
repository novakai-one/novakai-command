import type { Outcome } from "./outcome.js";
import type { ProviderSession } from "./records/provider-session.js";
import type { TranscriptLine } from "./records/transcript-line.js";

/** Counts returned by one provider-source scan and commit pass. */
export interface IngestResult {
  readonly sources: number;
  readonly added: number;
  readonly duplicates: number;
  readonly sessionsRegistered: number;
}

/** Observable lifecycle and most recent result for the ingest runtime. */
export interface MessagingHealth {
  readonly state: "stopped" | "running" | "degraded";
  readonly ingesting: boolean;
  readonly runs: number;
  readonly lastResult?: IngestResult;
  readonly lastError?: string;
}

/** Host-facing control and committed-query surface for transcript ingestion. */
export interface MessagingRuntimeApi {
  start(): Promise<Outcome<void>>;
  stop(): Promise<Outcome<void>>;
  health(): Promise<MessagingHealth>;
  ingestNow(): Promise<Outcome<IngestResult>>;
  listProviderSessions(): Promise<Outcome<readonly ProviderSession[]>>;
  listTranscriptLines(input?: unknown): Promise<Outcome<readonly TranscriptLine[]>>;
}
