import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { AgentBuffer } from '../../buffer.js';
import type { AgentActivity, AgentInfo, CreateAgentOptions } from '../../manager.js';
import type { TerminalRuntime } from '../../runtime/index.js';
import type { SubmitJob } from '../protocol/index.js';
import {
  TERMINAL_HOST_PROTOCOL,
  encodeFrame,
  type HostCommand,
  type HostFrame,
} from '../protocol/index.js';

interface CachedAgent {
  info: AgentInfo;
  buffer: AgentBuffer;
  cursor: number;
  activity: AgentActivity;
}

interface PendingCreate {
  resolve(info: AgentInfo): void;
  reject(error: Error): void;
}

interface ConnectionState {
  pending: string[];
  settled: boolean;
}

type ResolveClient = (client: TerminalHostClient) => void;
type RejectClient = (error: Error) => void;

/** Backend adapter for the detached PTY owner. */
export class TerminalHostClient implements TerminalRuntime {
  private readonly agents = new Map<string, CachedAgent>();
  private readonly pendingCreates = new Map<string, PendingCreate>();
  private socket: Socket | null = null;
  private connectedHostPid: number | null = null;
  private connectedSnapshotId: string | null = null;
  private dataCallback: ((agentId: string, data: string) => void) | null = null;
  /** Multi-listener (N2): the messaging-v2 presence transport subscribes
   * alongside AgentsHub — neither may steal the other's exit truth. */
  private readonly exitCallbacks: Array<(agentId: string, exitCode: number | null) => void> = [];
  private sessionCallback: ((info: AgentInfo) => void) | null = null;

  private constructor(private readonly socketPath: string) {}

  static connect(socketPath: string): Promise<TerminalHostClient> {
    const client = new TerminalHostClient(socketPath);
    return client.open();
  }

  create(options: CreateAgentOptions): Promise<AgentInfo> {
    const requestId = randomUUID();
    return new Promise<AgentInfo>((resolve, reject) => {
      this.pendingCreates.set(requestId, { resolve, reject });
      if (!this.send({ type: 'create', requestId, options })) {
        this.pendingCreates.delete(requestId);
        reject(new Error('terminal host is unavailable'));
      }
    });
  }

  write(agentId: string, data: string): boolean {
    return this.isRunning(agentId) && this.send({ type: 'write', agentId, data });
  }

  /** The submission job runs host-side, so its timers survive backend restarts (D2). */
  submit(job: SubmitJob): boolean {
    return this.isRunning(job.agentId) && this.send({ type: 'submit', job });
  }

  resize(agentId: string, cols: number, rows: number): boolean {
    return this.isRunning(agentId) && this.send({ type: 'resize', agentId, cols, rows });
  }

  rename(agentId: string, title: string): boolean {
    const record = this.agents.get(agentId);
    if (!record) return false;
    record.info = { ...record.info, title };
    return this.send({ type: 'rename', agentId, title });
  }

  kill(agentId: string): boolean {
    if (!this.agents.has(agentId)) return false;
    return this.send({ type: 'kill', agentId });
  }

  archive(agentId: string): boolean {
    if (!this.agents.has(agentId)) return false;
    return this.send({ type: 'archive', agentId });
  }

  snapshot(agentId: string): string {
    return this.agents.get(agentId)?.buffer.snapshot() ?? '';
  }

  /** Host-seeded on connect, client-stamped on live data frames (a copy). */
  activity(agentId: string): AgentActivity | null {
    const record = this.agents.get(agentId);
    return record ? { ...record.activity } : null;
  }

  list(): AgentInfo[] {
    return Array.from(this.agents.values(), ({ info }) => info);
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

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  hostPid(): number | null {
    return this.connectedHostPid;
  }

  /** The src/ snapshot the connected host was built from; null on pre-handshake hosts. */
  hostSnapshotId(): string | null {
    return this.connectedSnapshotId;
  }

  private open(): Promise<TerminalHostClient> {
    const socket = connect(this.socketPath);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      this.wireSocket(socket, resolve, reject);
    });
  }

  private wireSocket(socket: Socket, resolve: ResolveClient, reject: RejectClient): void {
    const state: ConnectionState = { pending: [], settled: false };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.handleChunk(socket, chunk, state, resolve, reject));
    socket.once('error', (error) => this.handleOpenError(error, state, reject));
    socket.on('close', () => this.handleClose());
  }

  private handleChunk(
    socket: Socket,
    chunk: string | Buffer,
    state: ConnectionState,
    resolve: ResolveClient,
    reject: RejectClient,
  ): void {
    const text = chunk.toString();
    let start = 0;
    let newline = text.indexOf('\n');
    while (newline >= 0) {
      state.pending.push(text.slice(start, newline));
      const line = state.pending.join('');
      state.pending = [];
      this.handleLine(socket, line, state, resolve, reject);
      start = newline + 1;
      newline = text.indexOf('\n', start);
    }
    if (start < text.length) state.pending.push(text.slice(start));
  }

  private handleLine(
    socket: Socket,
    line: string,
    state: ConnectionState,
    resolve: ResolveClient,
    reject: RejectClient,
  ): void {
    if (!line) return;
    const frame = this.parseFrame(socket, line);
    if (!frame) return;
    if (frame.type === 'ready' && !state.settled) this.handleReady(socket, frame, state, resolve, reject);
    else this.handleFrame(frame);
  }

  private parseFrame(socket: Socket, line: string): HostFrame | null {
    try {
      return JSON.parse(line) as HostFrame;
    } catch {
      socket.destroy(new Error('terminal host sent a malformed frame'));
      return null;
    }
  }

  private handleReady(
    socket: Socket,
    frame: Extract<HostFrame, { type: 'ready' }>,
    state: ConnectionState,
    resolve: ResolveClient,
    reject: RejectClient,
  ): void {
    state.settled = true;
    if (frame.protocol !== TERMINAL_HOST_PROTOCOL) {
      socket.destroy();
      reject(new Error(`terminal host protocol ${frame.protocol} is incompatible`));
      return;
    }
    this.replaceSnapshots(frame.agents);
    this.connectedHostPid = frame.hostPid;
    this.connectedSnapshotId = frame.snapshotId ?? null;
    resolve(this);
  }

  private handleOpenError(error: Error, state: ConnectionState, reject: RejectClient): void {
    if (state.settled) return;
    state.settled = true;
    reject(error);
  }

  private handleClose(): void {
    this.socket = null;
    const error = new Error('terminal host disconnected');
    for (const pendingCreate of this.pendingCreates.values()) pendingCreate.reject(error);
    this.pendingCreates.clear();
  }

  private replaceSnapshots(snapshots: Extract<HostFrame, { type: 'ready' }>['agents']): void {
    this.agents.clear();
    for (const snapshot of snapshots) {
      const buffer = new AgentBuffer();
      buffer.push(snapshot.data);
      this.agents.set(snapshot.info.agentId, {
        info: snapshot.info,
        buffer,
        cursor: snapshot.cursor,
        // Old hosts omit activity: fall back to a connect-time clock, which
        // resets the silence age (conservative) rather than inventing one.
        activity: snapshot.activity ?? { lastOutputAtMs: null, trackedSinceMs: Date.now() },
      });
    }
  }

  private handleFrame(frame: HostFrame): void {
    if (frame.type === 'created') return this.handleCreated(frame);
    if (frame.type === 'data') return this.handleData(frame);
    if (frame.type === 'exit') return this.handleExit(frame);
    if (frame.type === 'session') return this.handleSession(frame.info);
    if (frame.type === 'agents') this.replaceAgents(frame.agents);
  }

  private handleCreated(frame: Extract<HostFrame, { type: 'created' }>): void {
    const pending = this.pendingCreates.get(frame.requestId);
    if (!pending) return;
    this.pendingCreates.delete(frame.requestId);
    if (frame.info) pending.resolve(frame.info);
    else pending.reject(new Error(frame.error ?? 'terminal host failed to create agent'));
  }

  private handleData(frame: Extract<HostFrame, { type: 'data' }>): void {
    const record = this.agents.get(frame.agentId);
    if (!record || frame.cursor <= record.cursor) return;
    if (frame.cursor !== record.cursor + 1) {
      this.socket?.destroy(new Error(`terminal output gap for ${frame.agentId}`));
      return;
    }
    record.cursor = frame.cursor;
    record.activity.lastOutputAtMs = Date.now();
    record.buffer.push(frame.data);
    this.dataCallback?.(frame.agentId, frame.data);
  }

  private handleExit(frame: Extract<HostFrame, { type: 'exit' }>): void {
    const record = this.agents.get(frame.agentId);
    if (record) record.info = { ...record.info, status: 'exited' };
    for (const callback of this.exitCallbacks) callback(frame.agentId, frame.exitCode);
  }

  private handleSession(info: AgentInfo): void {
    const record = this.agents.get(info.agentId);
    if (record) record.info = info;
    this.sessionCallback?.(info);
  }

  private replaceAgents(agents: AgentInfo[]): void {
    const activeIds = new Set(agents.map(({ agentId }) => agentId));
    for (const agentId of this.agents.keys()) {
      if (!activeIds.has(agentId)) this.agents.delete(agentId);
    }
    for (const info of agents) {
      const record = this.agents.get(info.agentId);
      if (record) record.info = info;
      else {
        this.agents.set(info.agentId, {
          info,
          buffer: new AgentBuffer(),
          cursor: 0,
          activity: { lastOutputAtMs: null, trackedSinceMs: Date.now() },
        });
      }
    }
  }

  private isRunning(agentId: string): boolean {
    return this.agents.get(agentId)?.info.status === 'running';
  }

  private send(command: HostCommand): boolean {
    if (!this.socket?.writable || this.socket.destroyed) return false;
    this.socket.write(encodeFrame(command));
    return true;
  }
}
