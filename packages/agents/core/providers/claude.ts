// core/providers/claude.ts — the CLAUDE provider adapter (DEC-B1-4).
//
// Mirrors the kimi adapter's proven shape against the ratified terminal
// mini-contract (R3-15). Provider-specific code lives ONLY here (red gate 2).
//
// The machine surface (verified LIVE against Claude Code 2.1.219, 2026-07-28 —
// `claude --help` plus a real recorded run):
//
//     claude -p "<prompt>" --output-format stream-json --verbose
//            [--model <alias>] [--resume <session-id>]
//
//   `--verbose` is REQUIRED: with `-p --output-format stream-json` the CLI
//   refuses to stream without it. stdout, one JSON object per line:
//     {"type":"system","subtype":"init","session_id":"51974ac1-…"}  ← RESUME handle
//     {"type":"assistant","message":{"content":[{"type":"text","text":…}],
//                                    "usage":{…}}}                 ← user-facing
//     {"type":"result","subtype":"success","result":"…","usage":{…}} ← turn total
//
//   The `result` line REPEATS the assistant's text. Only assistant lines are
//   emitted, or every reply would be posted to Chris twice.
//
// RESUME: `--resume <session_id>`, where the id is the one printed on the
// `system/init` line (and is the transcript filename in
// ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl). Verified present in
// `claude --help` as `-r, --resume [value]`.
//
// MODEL: `--model <alias>` at spawn. Mid-session switch has no verified
// mechanism → no `setModel` on this runtime → typed UnsupportedOperation at the
// contract layer (OD-C3). Recorded in NOTES.md.
//
// USAGE (DEC-B1-7): the `result` line's `usage` block is the TURN total
// (input_tokens / output_tokens / cache_read_input_tokens /
// cache_creation_input_tokens) — per-turn, not cumulative, so it is emitted
// with cumulative=false. Unlike codex, claude's numbers need no baseline.
import { spawn, type ChildProcess } from 'node:child_process';
import type { ProviderCliRuntime, ProviderTurnRecord, ProviderTurnUsage } from './adapter.js';
import { cliExists, parseJsonLine, readLines, resolveCliPath } from './cli.js';

/** Where the claude CLI lives — an npm-global bin, so PATH is the source. */
export function defaultClaudeCliPath(): string {
  return resolveCliPath('claude');
}

/** Red gate 3: these values mean "pass no --model flag; let claude decide". */
const NO_MODEL_FLAG = new Set(['cli-default', 'claude-cli', '']);

interface LogicalSession {
  key: string;
  status: 'running' | 'exited';
  /** claude's own session id, learned from system/init — the resume handle. */
  cliSessionId: string | null;
  /** Serializes per-message child processes: one prompt in flight at a time. */
  queue: Promise<void>;
  current: ChildProcess | null;
  /** Provider-native spawn config (§22 ruling 5): argv is PREPENDED per message. */
  argv: string[];
  env: Record<string, string>;
  model: string | null;
  cwd: string;
  turns: number;
}

export interface ClaudeCliRuntime extends ProviderCliRuntime {
  /** No mid-session model mechanism exists for claude — deliberately absent. */
  setModel?: never;
}

export interface ClaudeCliRuntimeOptions {
  cwd: string;
  cliPath?: string;
}

export function createClaudeCliRuntime(options: ClaudeCliRuntimeOptions): ClaudeCliRuntime {
  const cliPath = options.cliPath ?? defaultClaudeCliPath();
  const sessions = new Map<string, LogicalSession>();
  const dataCallbacks: Array<(key: string, data: string) => void> = [];
  const exitCallbacks: Array<(key: string, exitCode: number | null) => void> = [];
  const turnCallbacks: Array<(record: ProviderTurnRecord) => void> = [];

  const emitData = (key: string, data: string): void => {
    for (const cb of dataCallbacks) cb(key, data);
  };

  interface TurnState { usage: ProviderTurnUsage | null }

  interface ClaudeUsage {
    input_tokens?: number; output_tokens?: number;
    cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
  }

  const toUsage = (raw: ClaudeUsage): ProviderTurnUsage => ({
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadTokens: raw.cache_read_input_tokens ?? 0,
    cacheCreationTokens: raw.cache_creation_input_tokens ?? 0,
    // The result line reports THIS turn's totals — no baseline needed.
    cumulative: false,
  });

  /** One JSONL event. Returns displayable text, or null when it is internal. */
  const handleEvent = (line: string, rec: LogicalSession, turn: TurnState): string | null => {
    const parsed = parseJsonLine<{
      type?: string; subtype?: string; session_id?: string; is_error?: boolean;
      message?: { content?: unknown; usage?: ClaudeUsage };
      usage?: ClaudeUsage;
      result?: unknown;
    }>(line);
    if (!parsed) return null;
    // Every line carries session_id; init is simply the first. Learning it from
    // any line means a format tweak upstream cannot silently lose our resume
    // handle — the one field the whole restart story depends on.
    if (!rec.cliSessionId && typeof parsed.session_id === 'string') {
      rec.cliSessionId = parsed.session_id;
    }
    if (parsed.type === 'result') {
      if (parsed.usage) turn.usage = toUsage(parsed.usage);
      // The result text duplicates the assistant line; never emitted.
      return null;
    }
    if (parsed.type !== 'assistant') return null;
    // Per-message usage is a fallback: a turn that ends without a result line
    // (an interrupted stream) still reports what it did report.
    if (parsed.message?.usage && !turn.usage) turn.usage = toUsage(parsed.message.usage);
    const content = parsed.message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    // Text blocks only: tool_use blocks are the agent's internals.
    const text = content
      .filter((part): part is { type?: string; text?: unknown } =>
        typeof part === 'object' && part !== null)
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => String(part.text))
      .join('');
    return text || null;
  };

  /** Build the argv for one turn. The ONLY place claude flags are decided. */
  const argvFor = (rec: LogicalSession, text: string): string[] => {
    // --verbose is not optional: `-p --output-format stream-json` requires it.
    const args = [...rec.argv, '-p', text, '--output-format', 'stream-json', '--verbose'];
    if (rec.cliSessionId) args.push('--resume', rec.cliSessionId);
    if (rec.model && !NO_MODEL_FLAG.has(rec.model)) args.push('--model', rec.model);
    return args;
  };

  /** One user message → one child process; resolves when the reply is fully read. */
  const runPrompt = (rec: LogicalSession, text: string): Promise<void> => new Promise((resolve) => {
    if (rec.status !== 'running') {
      resolve();
      return;
    }
    const startedAt = new Date().toISOString();
    const modelUsed = rec.model && !NO_MODEL_FLAG.has(rec.model) ? rec.model : null;
    const turn: TurnState = { usage: null };
    const child = spawn(cliPath, argvFor(rec, text), {
      cwd: rec.cwd,
      env: { ...process.env, ...rec.env },
      // The prompt is always an argv value; claude reads stdin when it is piped,
      // so stdin is closed rather than left open waiting.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rec.current = child;
    const flush = readLines(child.stdout, (line) => {
      const out = handleEvent(line, rec, turn);
      if (out) emitData(rec.key, out);
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const finish = (exitCode: number | null): void => {
      rec.current = null;
      rec.turns += 1;
      const record: ProviderTurnRecord = {
        key: rec.key, cliSessionId: rec.cliSessionId, startedAt,
        endedAt: new Date().toISOString(), exitCode, model: modelUsed, usage: turn.usage,
      };
      for (const cb of turnCallbacks) cb(record);
      resolve();
    };
    child.on('error', (error) => {
      emitData(rec.key, `⚠️ failed to start claude CLI: ${error.message}`);
      finish(null);
    });
    child.on('close', (code) => {
      flush();
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        emitData(rec.key, `⚠️ claude CLI exited with code ${code}${detail ? ` — ${detail}` : ''}`);
      }
      finish(code);
    });
  });

  return {
    isAvailable: () => cliExists(cliPath),

    async create(createOptions) {
      const key = createOptions.agentId ?? `agent_${Date.now()}`;
      if (sessions.has(key)) {
        throw new Error(`session key "${key}" already exists in the claude runtime`);
      }
      if (!cliExists(cliPath)) {
        throw new Error(`claude CLI not found at "${cliPath}" — cannot spawn a real Claude agent`);
      }
      sessions.set(key, {
        key, status: 'running', cliSessionId: null, queue: Promise.resolve(), current: null,
        argv: createOptions.argv ?? [], env: createOptions.env ?? {},
        model: createOptions.model ?? null,
        cwd: createOptions.cwd || options.cwd,
        turns: 0,
      });
      return { agentId: key, status: 'running' as const };
    },

    write(key, data) {
      const rec = sessions.get(key);
      if (!rec || rec.status !== 'running') return false;
      rec.queue = rec.queue.then(() => runPrompt(rec, data)).catch(() => undefined);
      return true;
    },

    kill(key) {
      const rec = sessions.get(key);
      if (!rec) return false;
      if (rec.status !== 'exited') {
        rec.status = 'exited';
        rec.current?.kill();
        rec.queue = Promise.resolve();
        for (const cb of exitCallbacks) cb(key, null);
      }
      return true;
    },

    list() {
      return [...sessions.values()].map((rec) => ({ agentId: rec.key, status: rec.status }));
    },

    onData(callback) { dataCallbacks.push(callback); },
    onExit(callback) { exitCallbacks.push(callback); },
    onTurn(callback) { turnCallbacks.push(callback); },

    isIdle(key) {
      const session = sessions.get(key);
      return session !== undefined && session.status === 'running' && session.current === null;
    },

    resumeHint(key) {
      return sessions.get(key)?.cliSessionId ?? null;
    },

    async drain(key) {
      await (sessions.get(key)?.queue ?? Promise.resolve());
    },

    /** Restart path (DEC-B1-6): rebuild the logical session around its session id. */
    adopt(key, adoptOptions) {
      const existing = sessions.get(key);
      if (existing) {
        existing.cliSessionId = adoptOptions.cliSessionId;
        if (adoptOptions.model !== undefined) existing.model = adoptOptions.model;
        return;
      }
      sessions.set(key, {
        key, status: 'running', cliSessionId: adoptOptions.cliSessionId,
        queue: Promise.resolve(), current: null,
        argv: adoptOptions.argv ?? [], env: adoptOptions.env ?? {},
        model: adoptOptions.model ?? null, cwd: options.cwd, turns: 0,
      });
    },
  };
}
