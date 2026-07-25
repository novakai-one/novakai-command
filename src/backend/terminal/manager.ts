import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ProviderId } from '../../shared/project/schema.js';
import { encodeCwd } from '../transcript/parser.js';
import { AgentBuffer } from './buffer.js';
import {
  launchProvider,
  type ProviderLauncher,
  type ProviderTerminalProcess,
} from './provider/index.js';

export interface AgentInfo {
  agentId: string;
  title: string;
  provider: ProviderId;
  sessionId: string;
  sessionError?: string;
  projectDir: string;
  cwd: string;
  status: 'running' | 'exited';
  terminalPid?: number;
  createdAt: string;
  projectId?: string;
  threadId?: string;
}

type RegistryEntry = AgentInfo & { archived?: boolean };

/** PTY-owner activity truth for one agent (capture point: the onData seam). */
export interface AgentActivity {
  /** ms epoch of the last PTY output chunk; null = none since tracking began. */
  lastOutputAtMs: number | null;
  /** ms epoch when tracking began (create / restore). */
  trackedSinceMs: number;
}

interface AgentRecord {
  info: AgentInfo;
  ptyProcess?: ProviderTerminalProcess;
  buffer?: AgentBuffer;
  archived?: boolean;
  cancelSessionWait?: (reason?: string) => void;
  activity: AgentActivity;
}

export interface CreateAgentOptions {
  title?: string;
  cwd: string;
  provider?: ProviderId;
  projectId?: string;
  threadId?: string;
  /** Durable object-model identity minted by the spawn path — the runtime
   * adopts it verbatim so there is exactly one agentId (ruling S4). */
  agentId?: string;
}

/** Tracking starts now, with no output observed yet. */
function freshActivity(): AgentActivity {
  return { lastOutputAtMs: null, trackedSinceMs: Date.now() };
}

/** Unref'd sleep: pending lifecycle steps never block process shutdown. */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function buildAgentInfo(
  agentId: string,
  sessionId: string,
  options: CreateAgentOptions,
  terminalPid?: number,
): AgentInfo {
  return {
    agentId,
    title: options.title || 'agent',
    provider: options.provider || 'claude',
    sessionId,
    projectDir: encodeCwd(options.cwd),
    cwd: options.cwd,
    status: 'running',
    ...(terminalPid === undefined ? {} : { terminalPid }),
    createdAt: new Date().toISOString(),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {})
  };
}

export class TerminalManager {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly pendingCodexCwds = new Set<string>();
  /** Insertion-ordered dedupe of submitted job ids (bounded, D2 idempotence). */
  private readonly submittedMessageIds = new Set<string>();
  /** One serialized submission lane per agent (correction C2). */
  private readonly submitLanes = new Map<string, Promise<void>>();
  private dataCallback: ((agentId: string, data: string) => void) | null = null;
  /** Multi-listener (N2): the messaging-v2 presence transport subscribes
   * alongside AgentsHub — neither may steal the other's exit truth. */
  private readonly exitCallbacks: Array<(agentId: string, exitCode: number | null) => void> = [];
  private sessionCallback: ((info: AgentInfo) => void) | null = null;

  constructor(
    private readonly registryPath = path.join(process.cwd(), '.novakai-command', 'agents.json'),
    private readonly launcher: ProviderLauncher = launchProvider,
  ) {
    this.loadRegistry();
  }

  private loadRegistry(): void {
    if (!existsSync(this.registryPath)) return;
    try {
      const contents = readFileSync(this.registryPath, 'utf8');
      const entries = JSON.parse(contents) as RegistryEntry[];
      for (const entry of entries) this.restoreEntry(entry);
    } catch {
      // corrupt file: start empty rather than crash
    }
  }

  private restoreEntry(entry: RegistryEntry): void {
    const { archived, ...info } = entry;
    this.agents.set(info.agentId, {
      info: { ...info, provider: info.provider || 'claude', status: 'exited' },
      archived,
      activity: freshActivity(),
    });
  }

  private saveRegistry(): void {
    mkdirSync(path.dirname(this.registryPath), { recursive: true });
    const entries: RegistryEntry[] = Array.from(this.agents.values(), (record) => ({
      ...record.info,
      archived: record.archived
    }));
    writeFileSync(this.registryPath, JSON.stringify(entries, null, 2));
  }

  async create(options: CreateAgentOptions): Promise<AgentInfo> {
    const provider = options.provider || 'claude';
    if (provider === 'codex' && this.pendingCodexCwds.has(options.cwd)) {
      throw new Error(`A Codex session is already starting for ${options.cwd}`);
    }
    if (provider === 'codex') this.pendingCodexCwds.add(options.cwd);
    try {
      return this.launchAgent(options);
    } catch (error) {
      if (provider === 'codex') this.pendingCodexCwds.delete(options.cwd);
      throw error;
    }
  }

  private launchAgent(options: CreateAgentOptions): AgentInfo {
    const agentId = options.agentId ?? `agent_${randomUUID()}`;
    if (this.agents.has(agentId)) throw new Error(`agentId "${agentId}" already exists in the terminal registry`);
    const requestedSessionId = randomUUID();
    const launched = this.launcher(options.provider || 'claude', options.cwd, requestedSessionId, agentId);
    const provider = options.provider || 'claude';
    const info = buildAgentInfo(agentId, provider === 'claude' ? requestedSessionId : '', options, launched.process.pid);
    const buffer = new AgentBuffer();
    this.agents.set(agentId, {
      info, ptyProcess: launched.process, buffer, cancelSessionWait: launched.cancelSessionWait,
      activity: freshActivity(),
    });
    this.wire(agentId, launched.process, buffer);
    this.saveRegistry();
    this.watchSessionIdentity(launched.sessionId, info, provider, options.cwd);
    return info;
  }

  private watchSessionIdentity(
    sessionId: Promise<string>, info: AgentInfo, provider: ProviderId, cwd: string,
  ): void {
    void sessionId.then((resolved) => {
      info.sessionId = resolved;
      delete info.sessionError;
      if (provider === 'codex') this.pendingCodexCwds.delete(cwd);
      this.saveRegistry();
      this.sessionCallback?.(info);
    }).catch((error) => {
      info.sessionError = error instanceof Error ? error.message : String(error);
      if (provider === 'codex') this.pendingCodexCwds.delete(cwd);
      this.saveRegistry();
      this.sessionCallback?.(info);
    });
  }

  private wire(agentId: string, proc: ProviderTerminalProcess, buffer: AgentBuffer): void {
    proc.onData((data) => {
      const record = this.agents.get(agentId);
      if (record) record.activity.lastOutputAtMs = Date.now();
      buffer.push(data);
      this.dataCallback?.(agentId, data);
    });
    proc.onExit(({ exitCode }) => {
      const record = this.agents.get(agentId);
      if (!record) return;
      record.info.status = 'exited';
      record.cancelSessionWait?.(
        `${record.info.provider} exited (code ${exitCode}) before its session was discovered`,
      );
      this.saveRegistry();
      for (const callback of this.exitCallbacks) callback(agentId, exitCode);
    });
  }

  write(agentId: string, data: string): boolean {
    const record = this.agents.get(agentId);
    if (!record?.ptyProcess) return false;
    record.ptyProcess.write(data);
    return true;
  }

  /**
   * One timed provider submission owned by the PTY-owning process (D2): type
   * the text, settle, submit with \r, and optionally flush with one more bare
   * \r. Jobs are serialized PER AGENT across the FULL lifecycle (correction
   * C2): job N+1's text never touches the PTY before job N's submit (and
   * flush) have run, so two sends inside the settle window can never merge.
   * Duplicate messageIds are no-ops so a reconciliation retry can never
   * double-type. In-process this dies with the process — the detached host
   * variant is what survives backend restarts.
   */
  submit(submission: { agentId: string; messageId: string; text: string; settleMs: number; flushMs?: number; leadIn?: { data: string; settleMs: number } }): boolean {
    if (this.submittedMessageIds.has(submission.messageId)) return true;
    if (!this.agents.get(submission.agentId)?.ptyProcess) return false;
    this.rememberSubmitted(submission.messageId);
    const lane = this.submitLanes.get(submission.agentId) ?? Promise.resolve();
    const chained = lane.then(() => this.runSubmission(submission));
    this.submitLanes.set(submission.agentId, chained.catch(() => undefined));
    return true;
  }

  /** The full lifecycle of one queued submission; a PTY death mid-queue is a quiet no-op. */
  private async runSubmission(submission: { agentId: string; messageId: string; text: string; settleMs: number; flushMs?: number; leadIn?: { data: string; settleMs: number } }): Promise<void> {
    if (submission.leadIn) {
      if (!this.write(submission.agentId, submission.leadIn.data)) return;
      await pause(submission.leadIn.settleMs);
    }
    if (!this.write(submission.agentId, submission.text)) return;
    await pause(submission.settleMs);
    this.write(submission.agentId, '\r');
    if (submission.flushMs !== undefined) {
      await pause(Math.max(0, submission.flushMs - submission.settleMs));
      this.write(submission.agentId, '\r');
    }
  }

  private rememberSubmitted(messageId: string): void {
    this.submittedMessageIds.add(messageId);
    if (this.submittedMessageIds.size > 500) {
      const oldest = this.submittedMessageIds.values().next().value;
      if (oldest !== undefined) this.submittedMessageIds.delete(oldest);
    }
  }

  resize(agentId: string, cols: number, rows: number): boolean {
    const record = this.agents.get(agentId);
    if (!record?.ptyProcess) return false;
    record.ptyProcess.resize(cols, rows);
    return true;
  }

  rename(agentId: string, title: string): boolean {
    const record = this.agents.get(agentId);
    if (!record) return false;
    record.info.title = title;
    this.saveRegistry();
    return true;
  }

  kill(agentId: string): boolean {
    const record = this.agents.get(agentId);
    if (!record) return false;
    if (record.info.status !== 'running' || !record.ptyProcess) return true;
    record.ptyProcess.kill();
    return true;
  }

  archive(agentId: string): boolean {
    const record = this.agents.get(agentId);
    if (!record) return false;
    if (record.ptyProcess) record.ptyProcess.kill();
    record.archived = true;
    this.saveRegistry();
    return true;
  }

  snapshot(agentId: string): string {
    return this.agents.get(agentId)?.buffer?.snapshot() ?? '';
  }

  /** A copy of the PTY-owner activity stamp — callers cannot move the clock. */
  activity(agentId: string): AgentActivity | null {
    const record = this.agents.get(agentId);
    return record ? { ...record.activity } : null;
  }

  list(): AgentInfo[] {
    return Array.from(this.agents.values())
      .filter((record) => !record.archived)
      .map((record) => record.info);
  }

  onData(callback: (agentId: string, data: string) => void): void {
    this.dataCallback = callback;
  }

  onExit(callback: (agentId: string, exitCode: number | null) => void): void {
    this.exitCallbacks.push(callback);
  }

  onSession(callback: (info: AgentInfo) => void): void {
    this.sessionCallback = callback;
  }
}
