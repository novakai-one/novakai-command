// core/providers/kimi.ts — the KIMI provider adapter (DEC-B1-4).
//
// Promoted verbatim-in-behaviour from the S2 demo's kimiCliRuntime, which
// proved the mechanism against the real CLI; B1a moves it inside the capability
// that owns providers, so provider-specific code exists in exactly one place
// (red gate C1) and the demo shim can die (§9).
//
// The machine surface (verified against kimi 0.29.1, 2026-07-28):
//
//     kimi [--skills-dir <dir>...] -p "<prompt>" --output-format stream-json
//          [-S <cli_session_id>] [-m <alias>]
//
//   stdout, one JSON object per line:
//     {"role":"assistant","content":"..."}                        ← user-facing
//     {"role":"meta","type":"session.resume_hint","session_id":…} ← resume handle
//
// DEC-B1-5 (process model): ONE short-lived child process per message. The
// LOGICAL session (create/kill, presence online/offline) spans processes;
// continuity is provider-native resume via `-S`, never a long-lived process.
// "Terminate after meaningful work" is therefore structural: there is no idle
// process left to accumulate cost in.
//
// Usage records (DEC-B1-7): kimi 0.29.1 stream-json emits NO usage line — only
// the assistant and resume_hint lines above. The adapter counts TURNS (real
// data) and reports no token counts rather than inventing a format; token
// accounting for kimi comes from transcript parsing in B1b (DEC-B1-11).
// Recorded in packages/agents/NOTES.md.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { TerminalRuntimeLike } from './adapter.js';

/** Where the kimi CLI lives on a standard install. */
export function defaultKimiCliPath(): string {
  return path.join(homedir(), '.kimi-code', 'bin', 'kimi');
}

/**
 * Red gate 3: these values mean "pass no -m flag at all — use the model from
 * the user's own config.toml". 'kimi-cli' is the legacy seed value that shipped
 * in demo data; it is NOT a model name and must never be sent to the CLI.
 */
const NO_MODEL_FLAG = new Set(['cli-default', 'kimi-cli', '']);

export interface KimiTurnRecord {
  /** The logical session key (the agents sessionId). */
  key: string;
  /** The CLI conversation this turn ran in, if known by then. */
  cliSessionId: string | null;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  /** Model alias actually passed, or null when the CLI default was used. */
  model: string | null;
}

interface LogicalSession {
  key: string;
  status: 'running' | 'exited';
  /** The CLI's own conversation id, learned from the first reply (`-S` handle). */
  cliSessionId: string | null;
  /** Serializes per-message child processes: one prompt in flight at a time. */
  queue: Promise<void>;
  current: ChildProcess | null;
  /** Provider-native spawn config (§22 ruling 5): argv is PREPENDED per message. */
  argv: string[];
  env: Record<string, string>;
  /** OD-C3 RULED: sticky per CLI session; applied as `-m` on every invocation. */
  model: string | null;
  turns: number;
}

export interface KimiCliRuntime extends TerminalRuntimeLike {
  isAvailable(): boolean;
  /** The provider-native resume handle for a session (persisted by the registry). */
  resumeHint(key: string): string | null;
  /** Rebind a session to a known CLI conversation after a server restart. */
  adopt(key: string, options: { cliSessionId: string | null; model?: string | null; argv?: string[]; env?: Record<string, string> }): void;
  /**
   * Resolves when every message queued for this session has finished its child
   * process. The server awaits this on graceful shutdown so a turn in flight is
   * never orphaned; tests use it instead of sleeping.
   */
  drain(key: string): Promise<void>;
  /** Per-turn completion records — the session registry's usage input (DEC-B1-7). */
  onTurn(callback: (record: KimiTurnRecord) => void): void;
}

export interface KimiCliRuntimeOptions {
  cwd: string;
  cliPath?: string;
}

export function createKimiCliRuntime(options: KimiCliRuntimeOptions): KimiCliRuntime {
  const cliPath = options.cliPath ?? defaultKimiCliPath();
  const sessions = new Map<string, LogicalSession>();
  const dataCallbacks: Array<(key: string, data: string) => void> = [];
  const exitCallbacks: Array<(key: string, exitCode: number | null) => void> = [];
  const turnCallbacks: Array<(record: KimiTurnRecord) => void> = [];

  const emitData = (key: string, data: string): void => {
    for (const cb of dataCallbacks) cb(key, data);
  };

  /** Extract displayable text from one stream-json line; null = not user-facing. */
  const parseLine = (line: string, rec: LogicalSession): string | null => {
    let parsed: { role?: string; type?: string; session_id?: string; content?: unknown };
    try { parsed = JSON.parse(line); } catch { return null; }
    if (parsed.role === 'meta' && parsed.type === 'session.resume_hint' && typeof parsed.session_id === 'string') {
      rec.cliSessionId = parsed.session_id;
      return null;
    }
    if (parsed.role !== 'assistant') return null;
    const content = parsed.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : ''))
        .join('');
    }
    return null;
  };

  /** Build the argv for one turn. The ONLY place kimi flags are decided. */
  const argvFor = (rec: LogicalSession, text: string): string[] => {
    const args = [...rec.argv, '-p', text, '--output-format', 'stream-json'];
    if (rec.cliSessionId) args.push('-S', rec.cliSessionId);
    if (rec.model && !NO_MODEL_FLAG.has(rec.model)) args.push('-m', rec.model);
    return args;
  };

  /** One user message → one child process; resolves when the reply is fully read. */
  const runPrompt = (rec: LogicalSession, text: string): Promise<void> => new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const modelUsed = rec.model && !NO_MODEL_FLAG.has(rec.model) ? rec.model : null;
    const child = spawn(cliPath, argvFor(rec, text), {
      cwd: options.cwd,
      env: { ...process.env, ...rec.env },
    });
    rec.current = child;
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const out = parseLine(line, rec);
        if (out) emitData(rec.key, out);
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const finish = (exitCode: number | null): void => {
      rec.current = null;
      rec.turns += 1;
      const record: KimiTurnRecord = {
        key: rec.key, cliSessionId: rec.cliSessionId, startedAt,
        endedAt: new Date().toISOString(), exitCode, model: modelUsed,
      };
      for (const cb of turnCallbacks) cb(record);
      resolve();
    };
    child.on('error', (error) => {
      emitData(rec.key, `⚠️ failed to start kimi CLI: ${error.message}`);
      finish(null);
    });
    child.on('close', (code) => {
      const tail = buf.trim();
      if (tail) {
        const out = parseLine(tail, rec);
        if (out) emitData(rec.key, out);
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        emitData(rec.key, `⚠️ kimi CLI exited with code ${code}${detail ? ` — ${detail}` : ''}`);
      }
      finish(code);
    });
  });

  return {
    isAvailable: () => existsSync(cliPath),

    async create(createOptions) {
      const key = createOptions.agentId ?? `agent_${Date.now()}`;
      if (sessions.has(key)) {
        throw new Error(`session key "${key}" already exists in the kimi runtime`);
      }
      if (!existsSync(cliPath)) {
        throw new Error(`kimi CLI not found at "${cliPath}" — cannot spawn a real Kimi agent`);
      }
      sessions.set(key, {
        key, status: 'running', cliSessionId: null, queue: Promise.resolve(), current: null,
        argv: createOptions.argv ?? [], env: createOptions.env ?? {},
        model: createOptions.model ?? null, turns: 0,
      });
      return { agentId: key, status: 'running' as const };
    },

    // OD-C3 RULED (spike 2026-07-28): the kimi CLI switches an EXISTING
    // session's model via `-S <id> -m <alias>`, and the choice persists in the
    // CLI's own session record — so setting it here switches the session.
    setModel(key, model) {
      const rec = sessions.get(key);
      if (!rec || rec.status !== 'running') return false;
      rec.model = model;
      return true;
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

    /**
     * Restart path (DEC-B1-6): the registry knows the CLI conversation id, so
     * a rebooted server re-creates the logical session pointing at it. Nothing
     * is "attached" to — the next message spawns a fresh process with `-S`.
     */
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
        model: adoptOptions.model ?? null, turns: 0,
      });
    },
  };
}
