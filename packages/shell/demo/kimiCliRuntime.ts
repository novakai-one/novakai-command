// packages/shell/demo/kimiCliRuntime.ts — DEMO-SCOPED TerminalRuntimeLike
// that drives the REAL `kimi` CLI in its machine mode:
//
//   kimi -p "<prompt>" --output-format stream-json [-S <session_id>]
//
// Why not the full terminal host (src/backend/terminal, approach 1)? That
// host spawns the interactive TUI and its write/submit path types into the
// TUI; piping raw ANSI frame redraws through the agents live-lane into chat
// messages is unreadable, and prompt-mode is the CLI's supported
// non-interactive surface. So the demo uses one SHORT-LIVED child process
// per user message, threaded into a single conversation via the CLI's own
// session resume (-S <session_id>, captured from the stream-json
// session.resume_hint meta line). The LOGICAL session (TerminalRuntimeLike
// create/kill, presence online/offline) stays open across messages — only
// the per-message process exits.
//
// Structurally satisfies packages/agents TerminalRuntimeLike; injected via
// composeAgents({ terminalRuntime }) in demo/bridge.ts. No changes to
// packages/agents, packages/messaging, packages/foundation, or src/.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { TerminalRuntimeLike } from '../../agents/contract/index.js';

export function defaultKimiCliPath(): string {
  return path.join(homedir(), '.kimi-code', 'bin', 'kimi');
}

interface LogicalSession {
  agentId: string;
  status: 'running' | 'exited';
  /** The CLI's own conversation id, learned from the first reply. */
  cliSessionId: string | null;
  /** Serializes per-message child processes: one prompt in flight at a time. */
  queue: Promise<void>;
  current: ChildProcess | null;
  /** S2a (§22 ruling 5): provider-native spawn config honored per message
   * child — argv (e.g. `--skills-dir <dir>`) is PREPENDED to every
   * invocation; env is merged over process.env. */
  argv: string[];
  env: Record<string, string>;
  /** OD-C3 RULED: the session's current model alias — applied as `-m` on every
   * prompt-mode invocation; the CLI persists the switch in the session record
   * (spike: spec/pass2-s2/OD-C3-spike.md). */
  model: string | null;
}

export interface KimiCliRuntime extends TerminalRuntimeLike {
  isAvailable(): boolean;
}

export function createKimiCliRuntime(options: { cwd: string; cliPath?: string }): KimiCliRuntime {
  const cliPath = options.cliPath ?? defaultKimiCliPath();
  const sessions = new Map<string, LogicalSession>();
  const dataCallbacks: Array<(agentId: string, data: string) => void> = [];
  const exitCallbacks: Array<(agentId: string, exitCode: number | null) => void> = [];

  const emitData = (agentId: string, data: string): void => {
    for (const cb of dataCallbacks) cb(agentId, data);
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
    const c = parsed.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
    }
    return null;
  };

  /** One user message → one child process; resolves when the reply is fully read. */
  const runPrompt = (rec: LogicalSession, text: string): Promise<void> => new Promise((resolve) => {
    const args = [...rec.argv, '-p', text, '--output-format', 'stream-json'];
    if (rec.cliSessionId) args.push('-S', rec.cliSessionId);
    if (rec.model) args.push('-m', rec.model); // OD-C3: sticky per CLI session
    const child = spawn(cliPath, args, { cwd: options.cwd, env: { ...process.env, ...rec.env } });
    rec.current = child;
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const text = parseLine(line, rec);
        if (text) emitData(rec.agentId, text);
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      emitData(rec.agentId, `⚠️ failed to start kimi CLI: ${err.message}`);
      rec.current = null;
      resolve();
    });
    child.on('close', (code) => {
      const tail = buf.trim();
      if (tail) {
        const text = parseLine(tail, rec);
        if (text) emitData(rec.agentId, text);
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        emitData(rec.agentId, `⚠️ kimi CLI exited with code ${code}${detail ? ` — ${detail}` : ''}`);
      }
      rec.current = null;
      resolve();
    });
  });

  return {
    isAvailable: () => existsSync(cliPath),

    async create(createOptions) {
      const agentId = createOptions.agentId ?? `agent_${Date.now()}`;
      if (sessions.has(agentId)) {
        throw new Error(`agentId "${agentId}" already exists in the kimi-cli demo runtime`);
      }
      if (!existsSync(cliPath)) {
        throw new Error(`kimi CLI not found at "${cliPath}" — cannot spawn a real Kimi agent`);
      }
      sessions.set(agentId, {
        agentId, status: 'running', cliSessionId: null, queue: Promise.resolve(), current: null,
        argv: createOptions.argv ?? [], env: createOptions.env ?? {},
        model: createOptions.model ?? null,
      });
      return { agentId, status: 'running' as const };
    },

    // OD-C3 RULED (spike 2026-07-28): the kimi CLI switches an EXISTING
    // session's model via `-S <id> -m <alias>`; the choice persists in the
    // CLI's own session record, so setting it here switches the session.
    setModel(agentId, model) {
      const rec = sessions.get(agentId);
      if (!rec || rec.status !== 'running') return false;
      rec.model = model;
      return true;
    },

    write(agentId, data) {
      const rec = sessions.get(agentId);
      if (!rec || rec.status !== 'running') return false;
      rec.queue = rec.queue.then(() => runPrompt(rec, data)).catch(() => undefined);
      return true;
    },

    kill(agentId) {
      const rec = sessions.get(agentId);
      if (!rec) return false;
      if (rec.status !== 'exited') {
        rec.status = 'exited';
        rec.current?.kill();
        for (const cb of exitCallbacks) cb(agentId, null);
      }
      return true;
    },

    list() {
      return [...sessions.values()].map((rec) => ({ agentId: rec.agentId, status: rec.status }));
    },

    onData(callback) { dataCallbacks.push(callback); },
    onExit(callback) { exitCallbacks.push(callback); },
  };
}
