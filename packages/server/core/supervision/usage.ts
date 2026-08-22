// packages/server/core/supervision/usage.ts — REAL per-session token
// accounting (DEC-B1-11), plus the codex cumulative calibration.
//
// §13 disposition 1 rules that `scripts/agent-watchdog.mjs` is READ-ONLY with
// respect to `.novakai/`, and that the server's supervision engine — the sole
// writer of `.novakai/supervision/usage.jsonl` — embeds the SAME parser module.
// This file is that module: the watchdog's three parsers, ported, with the
// fixture-backed corrections B1b measured.
//
// Everything here READS. It prefers Novakai's raw custody copies under
// `.novakai/transcripts/` and falls back to provider originals when a current
// session has not been copied yet. Both are read-only evidence paths.
//
// ── THE CALIBRATION ────────────────────────────────────────────────────────
// claude and kimi write PER-MESSAGE / PER-STEP usage records: summing them is
// the cost. codex writes a RUNNING SESSION TOTAL (`total_token_usage`) on every
// `token_count` event — measured live on 2026-07-28, one thread, two turns:
//
//     turn 1   total 21312   last 21312
//     turn 2   total 45338   last 24026
//
// So codex needs two corrections, both of which this module makes:
//   1. take the LAST total, never the sum (summing bills 66650 for 45338);
//   2. subtract a per-session BASELINE, so a novakai session that adopted an
//      already-running codex thread is not billed for the turns it never made.
// The baseline is zero for a thread novakai created (nothing is lost), and the
// raw total plus the subtracted baseline are BOTH reported so the adjustment is
// visible rather than magic.
import { readdir, readFile, stat } from 'node:fs/promises';
import type {
  ProviderTranscriptUsage,
} from '../../../agents/contract/index.js';
import type { ProviderName } from '../../contract/config.js';

/** What a provider transcript actually said. */
export type ParsedUsage = ProviderTranscriptUsage;

export interface UsageBaseline {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  at: string;
}

/** One row of the table Chris sees. */
export interface SessionUsage {
  /** This session's own cost. NULL means "not knowable", never a guessed 0. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  lastActivityAt: string | null;
  basis: 'transcript' | 'unavailable';
  /** The raw running total, when the provider reports one. */
  providerTotal: ParsedUsage | null;
  /** What was subtracted, and when it was taken. Null = nothing subtracted. */
  baseline: UsageBaseline | null;
  cumulativeAdjusted: boolean;
  /** True when only a provably attributable subset of provider evidence was counted. */
  usagePartial: boolean;
  /** The transcript this row came from, so any number can be traced to a file. */
  source: string | null;
  /** Plain-language provenance — a gap always states itself here. */
  note: string;
}

// ── the reader ─────────────────────────────────────────────────────────────

export interface UsageSessionRef {
  sessionId: string;
  provider: ProviderName;
  providerConversationId: string | null;
  cwd: string;
}

export interface UsageReader {
  /**
   * Declare how a session came to exist. `threadPreexisting: true` (novakai
   * ADOPTED a thread that was already running — a reattach after restart) bills
   * only what happens from here on. `false` is the default for every session
   * and needs no call.
   *
   * The default is deliberately the safe one. When "unknown session" meant
   * "baseline at first read", a live codex session that had really spent 41,814
   * tokens reported 0 — a silent undercount of real money. Over-attributing an
   * adopted thread is at least VISIBLE (the note says what was included), so
   * that is the failure this seam prefers.
   */
  trackSession(sessionId: string, options: { threadPreexisting: boolean }): void;
  read(session: UsageSessionRef): Promise<SessionUsage>;
  /** Read a whole interval from one shared discovery manifest. */
  readMany(sessions: UsageSessionRef[]): Promise<Map<string, SessionUsage>>;
  /** Forget a closed session's baseline. */
  forget(sessionId: string): void;
}

export interface UsageReaderOptions {
  /** Overridable for tests; production reads the operator's real home. */
  home?: string;
  /** `.novakai/transcripts/` raw-custody root. */
  transcriptRoot?: string;
  now?: () => string;
  /** Manifest lifetime; defaults to the five-minute supervision cadence. */
  discoveryIntervalMs?: number;
}

// Split-compat re-exports: every name usage.ts exported before the split
// keeps resolving from here, so no importer changes.
export {
  createUsageReader,
  parseClaudeTranscript,
  parseCodexRollout,
  parseKimiWire,
} from './reader.js';
export { sanitizeCwd } from './discovery.js';
