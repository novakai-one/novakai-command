// Provider transcript knowledge belongs to the agents provider capability.
// Consumers receive one deep contract: locate candidates and parse their JSONL
// records without learning any provider's on-disk layout or event vocabulary.
import path from 'node:path';
import type { ProviderName } from '../../contract/schemas.js';

export interface ProviderTranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** ISO time of the newest record, or null when the transcript carries no times. */
  lastActivityAt: string | null;
  /** True when the numbers are a running session total rather than turn costs. */
  cumulative: boolean;
}

export interface ProviderTranscriptLookup {
  conversationId: string;
  cwd: string;
  home: string;
  transcriptRoot?: string;
  files: string[];
}

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

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

export function sanitizeProviderCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function providerHasTranscript(provider: ProviderName): boolean {
  return provider === 'claude' || provider === 'codex' || provider === 'kimi';
}

/** Filesystem roots owned by the provider transcript capability. */
export function providerTranscriptRoots(
  home: string,
  transcriptRoot?: string,
): Array<{ root: string; depth: number }> {
  return [
    ...(transcriptRoot ? [{ root: transcriptRoot, depth: 9 }] : []),
    { root: path.join(home, '.claude', 'projects'), depth: 3 },
    { root: path.join(home, '.codex', 'sessions'), depth: 5 },
    { root: path.join(home, '.kimi-code', 'sessions'), depth: 6 },
  ];
}

function ownedBy(file: string, provider: Exclude<ProviderName, 'mock'>, transcriptRoot?: string): boolean {
  const copied = transcriptRoot !== undefined
    && (file === path.join(transcriptRoot, provider)
      || file.startsWith(`${path.join(transcriptRoot, provider)}${path.sep}`));
  const originalDir = provider === 'kimi' ? '.kimi-code' : `.${provider}`;
  return copied || file.includes(`${path.sep}${originalDir}${path.sep}`);
}

/**
 * Return every transcript candidate for a provider conversation. The consumer
 * chooses the newest readable candidate, so a stale custody copy cannot mask a
 * newer provider original while transcript watching is disabled.
 */
export function findProviderTranscriptCandidates(
  provider: ProviderName,
  lookup: ProviderTranscriptLookup,
): string[] {
  const { conversationId, cwd, home, transcriptRoot, files } = lookup;
  if (provider === 'claude') {
    const exact = path.join(
      home,
      '.claude',
      'projects',
      sanitizeProviderCwd(cwd),
      `${conversationId}.jsonl`,
    );
    return files.filter((file) =>
      file === exact
      || (ownedBy(file, 'claude', transcriptRoot)
        && path.basename(file) === `${conversationId}.jsonl`));
  }
  if (provider === 'codex') {
    return files.filter((file) =>
      ownedBy(file, 'codex', transcriptRoot)
      && path.basename(file).includes(conversationId));
  }
  if (provider === 'kimi') {
    return files.filter((file) =>
      ownedBy(file, 'kimi', transcriptRoot)
      && file.endsWith(path.join('agents', 'main', 'wire.jsonl'))
      && file.includes(conversationId));
  }
  return [];
}

function parseCodex(lines: Array<Record<string, unknown>>): ProviderTranscriptUsage {
  let total: Record<string, number> | null = null;
  let lastActivityAt: string | null = null;
  for (const line of lines) {
    lastActivityAt = newer(lastActivityAt, isoOf(line.timestamp));
    const payload = line.payload as {
      type?: string;
      info?: { total_token_usage?: Record<string, number> };
    } | undefined;
    if (payload?.type === 'token_count' && payload.info?.total_token_usage) {
      total = payload.info.total_token_usage;
    }
  }
  if (!total) return { ...ZERO, lastActivityAt, cumulative: true };
  return {
    inputTokens: total.input_tokens ?? 0,
    outputTokens: (total.output_tokens ?? 0) + (total.reasoning_output_tokens ?? 0),
    cacheReadTokens: total.cached_input_tokens ?? 0,
    cacheCreationTokens: 0,
    lastActivityAt,
    cumulative: true,
  };
}

function parseClaude(lines: Array<Record<string, unknown>>): ProviderTranscriptUsage {
  const byMessageId = new Map<string, Record<string, number>>();
  let lastActivityAt: string | null = null;
  for (const line of lines) {
    lastActivityAt = newer(lastActivityAt, isoOf(line.timestamp));
    const message = line.message as { id?: string; usage?: Record<string, number> } | undefined;
    if (message?.usage && message.id) byMessageId.set(message.id, message.usage);
  }
  const usage = { ...ZERO };
  for (const message of byMessageId.values()) {
    usage.inputTokens += message.input_tokens ?? 0;
    usage.outputTokens += message.output_tokens ?? 0;
    usage.cacheReadTokens += message.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += message.cache_creation_input_tokens ?? 0;
  }
  return { ...usage, lastActivityAt, cumulative: false };
}

function parseKimi(lines: Array<Record<string, unknown>>): ProviderTranscriptUsage {
  const usage = { ...ZERO };
  let newestMs = 0;
  for (const line of lines) {
    if (typeof line.time === 'number' && line.time > newestMs) newestMs = line.time;
    if (line.type !== 'context.append_loop_event') continue;
    const event = line.event as {
      type?: string;
      usage?: Record<string, number>;
    } | undefined;
    if (event?.type !== 'step.end' || !event.usage) continue;
    usage.inputTokens += event.usage.inputOther ?? 0;
    usage.outputTokens += event.usage.output ?? 0;
    usage.cacheReadTokens += event.usage.inputCacheRead ?? 0;
    usage.cacheCreationTokens += event.usage.inputCacheCreation ?? 0;
  }
  return {
    ...usage,
    lastActivityAt: newestMs ? new Date(newestMs).toISOString() : null,
    cumulative: false,
  };
}

export function parseProviderTranscriptLines(
  provider: ProviderName,
  lines: Array<Record<string, unknown>>,
): ProviderTranscriptUsage | null {
  if (provider === 'codex') return parseCodex(lines);
  if (provider === 'claude') return parseClaude(lines);
  if (provider === 'kimi') return parseKimi(lines);
  return null;
}
