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
import { homedir } from 'node:os';
import path from 'node:path';
import {
  findProviderTranscriptCandidates,
  parseProviderTranscriptLines,
  providerHasTranscript,
  providerTranscriptRoots,
  sanitizeProviderCwd,
  type ProviderTranscriptUsage,
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

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

const newerActivity = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

/** Parse JSONL text into objects. A corrupt line is skipped, never fatal. */
function parseJsonl(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* half-written tail */ }
  }
  return out;
}

/** Async file edge; transcript parsing never blocks the server event loop. */
async function readJsonl(file: string): Promise<Array<Record<string, unknown>> | null> {
  try { return parseJsonl(await readFile(file, 'utf8')); } catch { return null; }
}

export async function parseCodexRollout(file: string): Promise<ParsedUsage | null> {
  const lines = await readJsonl(file);
  return lines ? parseProviderTranscriptLines('codex', lines) : null;
}

export async function parseClaudeTranscript(file: string): Promise<ParsedUsage | null> {
  const lines = await readJsonl(file);
  return lines ? parseProviderTranscriptLines('claude', lines) : null;
}

export async function parseKimiWire(file: string): Promise<ParsedUsage | null> {
  const lines = await readJsonl(file);
  return lines ? parseProviderTranscriptLines('kimi', lines) : null;
}

// ── transcript discovery ───────────────────────────────────────────────────

/** claude sanitizes a cwd into its projects dir name: /a/b → -a-b. */
export function sanitizeCwd(cwd: string): string {
  return sanitizeProviderCwd(cwd);
}

/** Depth-limited async file listing. Never throws on an unreadable dir. */
async function walk(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, depth - 1));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * One discovery pass across every provider root. Usage intervals share this
 * manifest; no session is allowed to launch its own directory walk.
 */
async function discoverTranscripts(home: string, transcriptRoot?: string): Promise<string[]> {
  const roots = providerTranscriptRoots(home, transcriptRoot);
  return (await Promise.all(roots.map(({ root, depth }) => walk(root, depth)))).flat();
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

const unavailable = (note: string, source: string | null = null): SessionUsage => ({
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
  lastActivityAt: null, basis: 'unavailable', providerTotal: null, baseline: null,
  cumulativeAdjusted: false, usagePartial: false, source, note,
});

export function createUsageReader(options: UsageReaderOptions = {}): UsageReader {
  const home = options.home ?? homedir();
  const transcriptRoot = options.transcriptRoot;
  const now = options.now ?? (() => new Date().toISOString());
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 5 * 60 * 1000;
  /** sessionId → the cumulative figure we are NOT accountable for. */
  const baselines = new Map<string, UsageBaseline>();
  /** Sessions declared as ADOPTED. Everything else is a fresh thread. */
  const adopted = new Set<string>();
  /** One parse result per logical session, invalidated by file or mtime. */
  const parsedBySession = new Map<string, Map<string, {
    mtimeMs: number;
    parsed: ParsedUsage;
  }>>();
  let manifest: { atMs: number; files: string[] } | null = null;
  let discoveryInFlight: Promise<string[]> | null = null;

  const nowMs = (): number => {
    const parsed = Date.parse(now());
    return Number.isNaN(parsed) ? Date.now() : parsed;
  };

  const intervalManifest = async (): Promise<string[]> => {
    const atMs = nowMs();
    if (manifest && atMs - manifest.atMs < discoveryIntervalMs) return manifest.files;
    if (discoveryInFlight) return discoveryInFlight;
    const pass = discoverTranscripts(home, transcriptRoot);
    discoveryInFlight = pass;
    try {
      const files = await pass;
      manifest = { atMs, files };
      return files;
    } finally {
      if (discoveryInFlight === pass) discoveryInFlight = null;
    }
  };

  const parsedUsage = async (
    sessionId: string,
    provider: ProviderName,
    file: string,
  ): Promise<ParsedUsage | null> => {
    let mtimeMs: number;
    try { mtimeMs = (await stat(file)).mtimeMs; } catch { return null; }
    const sessionCache = parsedBySession.get(sessionId);
    const cached = sessionCache?.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached.parsed;
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch { return null; }
    const parsed = parseProviderTranscriptLines(provider, parseJsonl(text));
    if (!parsed) return null;
    const nextCache = sessionCache ?? new Map<string, { mtimeMs: number; parsed: ParsedUsage }>();
    nextCache.set(file, { mtimeMs, parsed });
    parsedBySession.set(sessionId, nextCache);
    return parsed;
  };

  const newestCandidateGroup = async (groups: string[][]): Promise<string[]> => {
    const dated = await Promise.all(groups.map(async (group) => {
      const mtimes = await Promise.all(group.map(async (file) => {
        try { return (await stat(file)).mtimeMs; } catch { return null; }
      }));
      const readable = mtimes.filter((mtime): mtime is number => mtime !== null);
      return readable.length > 0 ? { group, mtimeMs: Math.max(...readable) } : null;
    }));
    return dated
      .filter((candidate): candidate is { group: string[]; mtimeMs: number } => candidate !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.group ?? [];
  };

  const readFromManifest = async (
    session: UsageSessionRef,
    files: string[],
  ): Promise<SessionUsage> => {
    if (!providerHasTranscript(session.provider)) {
      return unavailable(`provider "${session.provider}" keeps no transcript to read`);
    }
    if (!session.providerConversationId) {
      return unavailable(
        'no provider conversation id yet — the handle is learned on the first reply',
      );
    }
    const selection = findProviderTranscriptCandidates(session.provider, {
      conversationId: session.providerConversationId,
      cwd: session.cwd,
      home,
      ...(transcriptRoot ? { transcriptRoot } : {}),
      files,
    });
    const selectedFiles = await newestCandidateGroup(selection.fileGroups);
    if (selectedFiles.length === 0) {
      return unavailable(
        `no ${session.provider} transcript found for conversation "${session.providerConversationId}"`,
      );
    }
    const parsedFiles = (await Promise.all(selectedFiles.map(async (file) => ({
      file,
      parsed: await parsedUsage(session.sessionId, session.provider, file),
    })))).filter((item): item is { file: string; parsed: ParsedUsage } => item.parsed !== null);
    const source = parsedFiles.map((item) => item.file).join(', ');
    if (parsedFiles.length === 0) {
      return unavailable(
        `${session.provider} transcript at ${selectedFiles.join(', ')} could not be read`,
        selectedFiles.join(', '),
      );
    }
    const usagePartial = selection.usagePartial || parsedFiles.length !== selectedFiles.length;
    const parsed = parsedFiles.reduce<ParsedUsage>((total, item) => ({
        inputTokens: total.inputTokens + item.parsed.inputTokens,
        outputTokens: total.outputTokens + item.parsed.outputTokens,
        cacheReadTokens: total.cacheReadTokens + item.parsed.cacheReadTokens,
        cacheCreationTokens: total.cacheCreationTokens + item.parsed.cacheCreationTokens,
        lastActivityAt: newerActivity(total.lastActivityAt, item.parsed.lastActivityAt),
        cumulative: item.parsed.cumulative,
      }), { ...ZERO, lastActivityAt: null, cumulative: parsedFiles[0]!.parsed.cumulative });

      if (!parsed.cumulative) {
        return {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheCreationTokens: parsed.cacheCreationTokens,
          lastActivityAt: parsed.lastActivityAt,
          basis: 'transcript',
          providerTotal: null,
          baseline: null,
          cumulativeAdjusted: false,
          usagePartial,
          source,
          note: usagePartial
            ? `${session.provider} main transcript is measured, but additional wire attribution could not be proven — usage is partial`
            : `${session.provider} transcript records are per-turn — ${parsedFiles.length} file(s) reported as measured`,
        };
      }

      // Cumulative provider (codex): establish the baseline once, then report
      // the delta. Both halves stay visible.
      //
      // An UNDECLARED session baselines at ZERO, not at first read. Anything
      // else silently reports "this session cost nothing" for a session that
      // spent real money — the live defect this default exists to prevent.
      let baseline = baselines.get(session.sessionId);
      if (!baseline) {
        baseline = adopted.has(session.sessionId)
          ? {
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            cacheReadTokens: parsed.cacheReadTokens,
            cacheCreationTokens: parsed.cacheCreationTokens,
            at: now(),
          }
          : { ...ZERO, at: now() };
        baselines.set(session.sessionId, baseline);
      }
      const sub = (total: number, base: number): number => Math.max(0, total - base);
      return {
        inputTokens: sub(parsed.inputTokens, baseline.inputTokens),
        outputTokens: sub(parsed.outputTokens, baseline.outputTokens),
        cacheReadTokens: sub(parsed.cacheReadTokens, baseline.cacheReadTokens),
        cacheCreationTokens: sub(parsed.cacheCreationTokens, baseline.cacheCreationTokens),
        lastActivityAt: parsed.lastActivityAt,
        basis: 'transcript',
        providerTotal: parsed,
        baseline,
        cumulativeAdjusted: true,
        usagePartial,
        source,
        note: adopted.has(session.sessionId)
          ? `codex totals are cumulative; this thread was adopted, so the baseline ${baseline.inputTokens} in / ${baseline.outputTokens} out taken at ${baseline.at} is excluded`
          : 'codex totals are cumulative; this thread belongs to novakai, so the baseline is 0 and the full total is billed',
      };
  };

  return {
    trackSession(sessionId, trackOptions) {
      if (trackOptions.threadPreexisting) {
        adopted.add(sessionId);
        baselines.delete(sessionId); // take it at the next read
        return;
      }
      adopted.delete(sessionId);
      baselines.set(sessionId, { ...ZERO, at: now() });
    },

    forget(sessionId) {
      baselines.delete(sessionId);
      adopted.delete(sessionId);
      parsedBySession.delete(sessionId);
    },

    async read(session) {
      const needsManifest = Boolean(
        providerHasTranscript(session.provider) && session.providerConversationId,
      );
      return readFromManifest(session, needsManifest ? await intervalManifest() : []);
    },

    async readMany(sessions) {
      const needsManifest = sessions.some(
        (session) => Boolean(
          providerHasTranscript(session.provider) && session.providerConversationId,
        ),
      );
      const files = needsManifest ? await intervalManifest() : [];
      const rows = await Promise.all(sessions.map(async (session) =>
        [session.sessionId, await readFromManifest(session, files)] as const));
      return new Map(rows);
    },
  };
}
