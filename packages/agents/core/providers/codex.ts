// core/providers/codex.ts — the CODEX provider adapter (DEC-B1-4).
//
// Mirrors the kimi adapter's proven shape against the ratified terminal
// mini-contract (R3-15). Provider-specific code lives ONLY here (red gate 2).
//
// The machine surface (verified LIVE against codex-cli 0.144.5, 2026-07-28 —
// `codex exec --help`, `codex exec resume --help`, and a real recorded run):
//
//     codex exec [--json] [-m <model>] [--skip-git-repo-check] "<prompt>"
//     codex exec resume [--json] [-m <model>] <session-id> "<prompt>"
//
//   stdout with --json, one JSON object per line:
//     {"type":"thread.started","thread_id":"019fa7b4-…"}   ← the RESUME handle
//     {"type":"turn.started"}
//     {"type":"item.completed","item":{"type":"reasoning","text":…}}     ← internal
//     {"type":"item.completed","item":{"type":"agent_message","text":…}} ← user-facing
//     {"type":"turn.completed","usage":{"input_tokens":21312,
//        "cached_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":0}}
//
// OD-B1-1 CLOSED: codex HAS resume. `codex exec resume <session-id> "<prompt>"`
// takes the thread_id printed on the first turn (it is also the session id in
// the rollout filename ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl).
// So the §13 disposition-5 "no-resume" fallback (rolling summary injection) is
// NOT needed for codex, and no history is re-injected per turn.
//
// GIT-REPO RULE (HANDOVER verified fact): codex refuses to run outside a git
// repository unless `--skip-git-repo-check` is passed. The adapter DETECTS the
// cwd instead of assuming: inside a repo it passes nothing; outside one it
// passes the flag, so a non-repo cwd degrades honestly rather than failing with
// an opaque provider error.
//
// MODEL: `-m <alias>` at spawn. Mid-session switch has no verified mechanism →
// no `setModel` on this runtime → typed UnsupportedOperation at the contract
// layer (OD-C3). Recorded in NOTES.md.
//
// USAGE (DEC-B1-7) — the calibration that live measurement corrected:
// `turn.completed.usage` in the stream tracks the rollout's cumulative
// `total_token_usage`, NOT the per-turn `last_token_usage`. Measured across two
// turns of one thread on 2026-07-28:
//     turn 1  stream 21312 · total 21312 · last 21312
//     turn 2  stream 45338 · total 45338 · last 24026
// So codex usage is emitted with `cumulative: true` and the supervision engine
// subtracts a per-session baseline. Treating it as a turn cost would overstate
// every turn after the first, by a margin that grows with the conversation.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProviderCliRuntime, ProviderTurnRecord, ProviderTurnUsage } from './adapter.js';
import { cliExists, parseJsonLine, readLines, resolveCliPath } from './cli.js';

/** Where the codex CLI lives — an npm-global bin, so PATH is the source. */
export function defaultCodexCliPath(): string {
  return resolveCliPath('codex');
}

/** Red gate 3: these values mean "pass no -m flag; let codex use its config". */
const NO_MODEL_FLAG = new Set(['cli-default', 'codex-cli', '']);

interface LogicalSession {
  key: string;
  status: 'running' | 'exited';
  /** codex's own thread id, learned from thread.started — the resume handle. */
  cliSessionId: string | null;
  /** Serializes per-message child processes: one prompt in flight at a time. */
  queue: Promise<void>;
  current: ChildProcess | null;
  /** Provider-native spawn config (§22 ruling 5): argv is PREPENDED per message. */
  argv: string[];
  env: Record<string, string>;
  model: string | null;
  /** The git-repo root codex runs in — codex needs one (or the skip flag). */
  cwd: string;
  turns: number;
}

export interface CodexCliRuntime extends ProviderCliRuntime {
  /** No mid-session model mechanism exists for codex — deliberately absent. */
  setModel?: never;
}

export interface CodexCliRuntimeOptions {
  /** Default cwd for spawned processes; codex wants a git-repo root. */
  cwd: string;
  cliPath?: string;
}

/**
 * Walk up from `dir` looking for a `.git` entry. Cheap, synchronous, and it
 * answers the only question codex asks of a cwd.
 */
export function isInsideGitRepo(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function createCodexCliRuntime(options: CodexCliRuntimeOptions): CodexCliRuntime {
  const cliPath = options.cliPath ?? defaultCodexCliPath();
  const sessions = new Map<string, LogicalSession>();
  const dataCallbacks: Array<(key: string, data: string) => void> = [];
  const exitCallbacks: Array<(key: string, exitCode: number | null) => void> = [];
  const turnCallbacks: Array<(record: ProviderTurnRecord) => void> = [];

  const emitData = (key: string, data: string): void => {
    for (const cb of dataCallbacks) cb(key, data);
  };

  interface TurnState { usage: ProviderTurnUsage | null }

  /** One JSONL event. Returns displayable text, or null when it is internal. */
  const handleEvent = (line: string, rec: LogicalSession, turn: TurnState): string | null => {
    const parsed = parseJsonLine<{
      type?: string;
      thread_id?: string;
      item?: { type?: string; text?: string };
      usage?: {
        input_tokens?: number; cached_input_tokens?: number;
        output_tokens?: number; reasoning_output_tokens?: number;
      };
    }>(line);
    if (!parsed) return null;
    if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
      rec.cliSessionId = parsed.thread_id;
      return null;
    }
    if (parsed.type === 'turn.completed' && parsed.usage) {
      turn.usage = {
        // codex counts reasoning tokens separately; they are billed output.
        inputTokens: parsed.usage.input_tokens ?? 0,
        outputTokens: (parsed.usage.output_tokens ?? 0) + (parsed.usage.reasoning_output_tokens ?? 0),
        cacheReadTokens: parsed.usage.cached_input_tokens ?? 0,
        cacheCreationTokens: 0, // codex reports no cache-creation counter
        // LIVE-MEASURED: turn.completed.usage tracks the rollout's
        // `total_token_usage`, NOT `last_token_usage` — it is the running
        // session total. Turn 2 of a two-turn thread streamed 45338 while the
        // turn itself cost 24026. The consumer deltas it (usage.ts).
        cumulative: true,
      };
      return null;
    }
    if (parsed.type !== 'item.completed') return null;
    // Only the agent's own message is user-facing; reasoning / command items
    // are the agent's internals and must never land in Chris's thread.
    if (parsed.item?.type !== 'agent_message') return null;
    return typeof parsed.item.text === 'string' ? parsed.item.text : null;
  };

  /** Build the argv for one turn. The ONLY place codex flags are decided. */
  const argvFor = (rec: LogicalSession, text: string): string[] => {
    const flags = ['--json', '--dangerously-bypass-hook-trust'];
    if (rec.model && !NO_MODEL_FLAG.has(rec.model)) flags.push('-m', rec.model);
    // Honest degradation instead of an opaque provider refusal.
    if (!isInsideGitRepo(rec.cwd)) flags.push('--skip-git-repo-check');
    return rec.cliSessionId
      ? [...rec.argv, 'exec', 'resume', ...flags, rec.cliSessionId, text]
      : [...rec.argv, 'exec', ...flags, text];
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
      // codex reads a prompt from stdin when one is piped; the prompt is always
      // an argv value here, so stdin is closed rather than left open.
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
      emitData(rec.key, `⚠️ failed to start codex CLI: ${error.message}`);
      finish(null);
    });
    child.on('close', (code) => {
      flush();
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        emitData(rec.key, `⚠️ codex CLI exited with code ${code}${detail ? ` — ${detail}` : ''}`);
      }
      finish(code);
    });
  });

  return {
    isAvailable: () => cliExists(cliPath),

    async create(createOptions) {
      const key = createOptions.agentId ?? `agent_${Date.now()}`;
      if (sessions.has(key)) {
        throw new Error(`session key "${key}" already exists in the codex runtime`);
      }
      if (!cliExists(cliPath)) {
        throw new Error(`codex CLI not found at "${cliPath}" — cannot spawn a real Codex agent`);
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

    resumeHint(key) {
      return sessions.get(key)?.cliSessionId ?? null;
    },

    async drain(key) {
      await (sessions.get(key)?.queue ?? Promise.resolve());
    },

    /** Restart path (DEC-B1-6): rebuild the logical session around its thread id. */
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
