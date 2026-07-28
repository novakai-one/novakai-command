// packages/server/core/supervision/usage.ts — REAL per-session token
// accounting (DEC-B1-11), plus the codex cumulative calibration.
//
// §13 disposition 1 rules that `scripts/agent-watchdog.mjs` is READ-ONLY with
// respect to `.novakai/`, and that the server's supervision engine — the sole
// writer of `.novakai/supervision/usage.jsonl` — embeds the SAME parser module.
// This file is that module: the watchdog's three parsers, ported, with the
// fixture-backed corrections B1b measured.
//
// Everything here READS. It opens the providers' own transcript files, which is
// what the standalone diagnostic already does (disposition 7's named
// exemption). It deliberately does NOT depend on the transcript watcher's
// copies under `.novakai/transcripts/`: B1a measured that copier starving the
// HTTP loop at real volume and left it off, and a usage table that only works
// when a disabled copier is on is a table that does not work.
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
import type { ProviderName } from '../../contract/config.js';

/** What a provider transcript actually said. */
export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** ISO time of the newest record, or null when the file carries no times. */
  lastActivityAt: string | null;
  /** True when the numbers are a running session total, not a turn cost. */
  cumulative: boolean;
}

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
  /** The transcript this row came from, so any number can be traced to a file. */
  source: string | null;
  /** Plain-language provenance — a gap always states itself here. */
  note: string;
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

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

const isoOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const newer = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

// ── the three parsers (ported from scripts/agent-watchdog.mjs) ─────────────

/**
 * codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl`).
 * `payload.type === 'token_count'` carries `info.total_token_usage`, which is
 * CUMULATIVE — the last one is the authoritative aggregate. Do not sum.
 */
function parseCodexLines(lines: Array<Record<string, unknown>>): ParsedUsage {
  let total: Record<string, number> | null = null;
  let lastActivityAt: string | null = null;
  for (const line of lines) {
    lastActivityAt = newer(lastActivityAt, isoOf(line.timestamp));
    const payload = line.payload as { type?: string; info?: { total_token_usage?: Record<string, number> } } | undefined;
    if (payload?.type === 'token_count' && payload.info?.total_token_usage) {
      total = payload.info.total_token_usage;
    }
  }
  if (!total) return { ...ZERO, lastActivityAt, cumulative: true };
  return {
    inputTokens: total.input_tokens ?? 0,
    // codex bills reasoning tokens as output; the table must not drop them.
    outputTokens: (total.output_tokens ?? 0) + (total.reasoning_output_tokens ?? 0),
    cacheReadTokens: total.cached_input_tokens ?? 0,
    cacheCreationTokens: 0, // codex reports no cache-creation counter
    lastActivityAt,
    cumulative: true,
  };
}

export async function parseCodexRollout(file: string): Promise<ParsedUsage | null> {
  const lines = await readJsonl(file);
  return lines ? parseCodexLines(lines) : null;
}

/**
 * claude transcript (`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`).
 * Per-message `message.usage` blocks. The SAME assistant message repeats across
 * lines in a real transcript, so records are deduped by message id — counting
 * them twice would double every claude bill.
 */
function parseClaudeLines(lines: Array<Record<string, unknown>>): ParsedUsage {
  const byMessageId = new Map<string, Record<string, number>>();
  let lastActivityAt: string | null = null;
  for (const line of lines) {
    lastActivityAt = newer(lastActivityAt, isoOf(line.timestamp));
    const message = line.message as { id?: string; usage?: Record<string, number> } | undefined;
    if (message?.usage && message.id) byMessageId.set(message.id, message.usage);
  }
  const acc = { ...ZERO };
  for (const usage of byMessageId.values()) {
    acc.inputTokens += usage.input_tokens ?? 0;
    acc.outputTokens += usage.output_tokens ?? 0;
    acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    acc.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  }
  return { ...acc, lastActivityAt, cumulative: false };
}

export async function parseClaudeTranscript(file: string): Promise<ParsedUsage | null> {
  const lines = await readJsonl(file);
  return lines ? parseClaudeLines(lines) : null;
}

/**
 * kimi wire — under `~/.kimi-code/sessions/`, a `wd_<hash>` working-dir bucket
 * holds `session_<id>/agents/main/wire.jsonl`.
 * The source B1a found when it established that kimi's stream-json emits NO
 * usage line: `context.append_loop_event` / `step.end` carries per-step usage.
 */
function parseKimiLines(lines: Array<Record<string, unknown>>): ParsedUsage {
  const acc = { ...ZERO };
  let newestMs = 0;
  for (const line of lines) {
    if (typeof line.time === 'number' && line.time > newestMs) newestMs = line.time;
    if (line.type !== 'context.append_loop_event') continue;
    const event = line.event as { type?: string; usage?: Record<string, number> } | undefined;
    if (event?.type !== 'step.end' || !event.usage) continue;
    acc.inputTokens += event.usage.inputOther ?? 0;
    acc.outputTokens += event.usage.output ?? 0;
    acc.cacheReadTokens += event.usage.inputCacheRead ?? 0;
    acc.cacheCreationTokens += event.usage.inputCacheCreation ?? 0;
  }
  return {
    ...acc,
    lastActivityAt: newestMs ? new Date(newestMs).toISOString() : null,
    cumulative: false,
  };
}

export async function parseKimiWire(file: string): Promise<ParsedUsage | null> {
  const lines = await readJsonl(file);
  return lines ? parseKimiLines(lines) : null;
}

// ── transcript discovery ───────────────────────────────────────────────────

/** claude sanitizes a cwd into its projects dir name: /a/b → -a-b. */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
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
async function discoverTranscripts(home: string): Promise<string[]> {
  const roots: Array<[string, number]> = [
    [path.join(home, '.claude', 'projects'), 3],
    [path.join(home, '.codex', 'sessions'), 5],
    [path.join(home, '.kimi-code', 'sessions'), 6],
  ];
  return (await Promise.all(roots.map(([root, depth]) => walk(root, depth)))).flat();
}

/** Resolve one conversation from an already-discovered interval manifest. */
function findInManifest(
  provider: ProviderName,
  conversationId: string,
  cwd: string,
  home: string,
  files: string[],
): string | null {
  if (provider === 'claude') {
    const dir = path.join(home, '.claude', 'projects', sanitizeCwd(cwd));
    const exact = path.join(dir, `${conversationId}.jsonl`);
    if (files.includes(exact)) return exact;
    return files.find((f) => path.basename(f) === `${conversationId}.jsonl`) ?? null;
  }
  if (provider === 'codex') {
    return files.find((f) =>
      f.includes(`${path.sep}.codex${path.sep}`)
      && path.basename(f).includes(conversationId)) ?? null;
  }
  if (provider === 'kimi') {
    return files.find((f) =>
      f.includes(`${path.sep}.kimi-code${path.sep}`)
      && path.basename(f) === 'wire.jsonl'
      && f.includes(conversationId)) ?? null;
  }
  return null; // mock has no transcript, and never pretends to
}

const PARSERS: Record<string, (lines: Array<Record<string, unknown>>) => ParsedUsage> = {
  claude: parseClaudeLines,
  codex: parseCodexLines,
  kimi: parseKimiLines,
};

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
  now?: () => string;
  /** Manifest lifetime; defaults to the five-minute supervision cadence. */
  discoveryIntervalMs?: number;
}

const unavailable = (note: string, source: string | null = null): SessionUsage => ({
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
  lastActivityAt: null, basis: 'unavailable', providerTotal: null, baseline: null,
  cumulativeAdjusted: false, source, note,
});

export function createUsageReader(options: UsageReaderOptions = {}): UsageReader {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date().toISOString());
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 5 * 60 * 1000;
  /** sessionId → the cumulative figure we are NOT accountable for. */
  const baselines = new Map<string, UsageBaseline>();
  /** Sessions declared as ADOPTED. Everything else is a fresh thread. */
  const adopted = new Set<string>();
  /** One parse result per logical session, invalidated by file or mtime. */
  const parsedBySession = new Map<string, {
    file: string;
    mtimeMs: number;
    parsed: ParsedUsage;
  }>();
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
    const pass = discoverTranscripts(home);
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
    const cached = parsedBySession.get(sessionId);
    if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.parsed;
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch { return null; }
    const parser = PARSERS[provider];
    if (!parser) return null;
    const parsed = parser(parseJsonl(text));
    parsedBySession.set(sessionId, { file, mtimeMs, parsed });
    return parsed;
  };

  const readFromManifest = async (
    session: UsageSessionRef,
    files: string[],
  ): Promise<SessionUsage> => {
    const parser = PARSERS[session.provider];
    if (!parser) {
      return unavailable(`provider "${session.provider}" keeps no transcript to read`);
    }
    if (!session.providerConversationId) {
      return unavailable(
        'no provider conversation id yet — the handle is learned on the first reply',
      );
    }
    const file = findInManifest(
      session.provider, session.providerConversationId, session.cwd, home, files);
    if (!file) {
      return unavailable(
        `no ${session.provider} transcript found for conversation "${session.providerConversationId}"`,
      );
    }
    const parsed = await parsedUsage(session.sessionId, session.provider, file);
    if (!parsed) {
      return unavailable(`${session.provider} transcript at ${file} could not be read`, file);
    }

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
          source: file,
          note: `${session.provider} records are per-turn — reported as measured`,
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
        source: file,
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
      const needsManifest = Boolean(PARSERS[session.provider] && session.providerConversationId);
      return readFromManifest(session, needsManifest ? await intervalManifest() : []);
    },

    async readMany(sessions) {
      const needsManifest = sessions.some(
        (session) => Boolean(PARSERS[session.provider] && session.providerConversationId),
      );
      const files = needsManifest ? await intervalManifest() : [];
      const rows = await Promise.all(sessions.map(async (session) =>
        [session.sessionId, await readFromManifest(session, files)] as const));
      return new Map(rows);
    },
  };
}
