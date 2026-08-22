// packages/server/core/supervision/reader.ts — the per-provider usage reader
// (split from usage.ts, SUPFIX step 0). Reads provider transcripts, applies
// the codex cumulative calibration, caches parses by mtime.
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  findProviderTranscriptCandidates,
  parseProviderTranscriptLines,
  providerHasTranscript,
} from '../../../agents/contract/index.js';
import type { ProviderName } from '../../contract/config.js';
import { discoverTranscripts } from './discovery.js';
import type {
  ParsedUsage,
  SessionUsage,
  UsageBaseline,
  UsageReader,
  UsageReaderOptions,
  UsageSessionRef,
} from './usage.js';

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
